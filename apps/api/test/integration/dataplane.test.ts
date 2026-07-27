import { describe, expect, test } from "bun:test"
import type { PoolSnapshot } from "../../src/services/routing"
import type { UsageRecord } from "../../src/services/usage"
import {
  account,
  jsonResponse,
  newRouterKey,
  slowStream,
  subscriptionAccount,
} from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, MESSAGE, post, settle } from "./harness"

/**
 * The data plane end to end: real Hono, real middleware, real routing, **mocked upstreams**.
 * Nothing here touches a network or a database — `fetch` and the key repository are injected, which
 * is exactly why they are dependencies. The harness itself lives in `./harness` and is shared with
 * `translate.test.ts`.
 */

describe("authentication", () => {
  test("accepts the OpenAI bearer form", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { ok: true })] })
    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(res.status).toBe(200)
  })

  test("accepts the Anthropic x-api-key form — one key works in either", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { ok: true })] })
    const res = await app.request("/v1/messages", post(MESSAGE, { "x-api-key": KEY }))
    expect(res.status).toBe(200)
  })

  test("rejects an unknown key with 401 in the ingress dialect's shape", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, {})] })
    const res = await app.request(
      "/v1/messages",
      post(MESSAGE, { authorization: `Bearer ${newRouterKey()}` }),
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    })
  })

  test("rejects a request carrying no key at all", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, {})] })
    expect((await app.request("/v1/messages", post())).status).toBe(401)
  })

  test("never reaches an upstream without a valid key", async () => {
    const { app, upstream } = harness({ responses: [() => jsonResponse(200, {})] })
    await app.request("/v1/messages", post(MESSAGE, { "x-api-key": "mar_live_nope" }))
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("same-dialect passthrough", () => {
  test("forwards the body byte for byte and swaps the credential", async () => {
    const { app, upstream } = harness({ responses: [() => jsonResponse(200, { ok: true })] })

    await app.request("/v1/messages", post(MESSAGE, { ...bearer(), "anthropic-beta": "future" }))
    const call = upstream.calls[0]

    expect(call?.body).toBe(MESSAGE)
    expect(call?.url).toBe("https://upstream.test/v1/messages")
    expect(call?.headers.get("x-api-key")).toBe("sk-one")
    expect(call?.headers.get("authorization")).toBeNull()
    // An unknown beta flag survives untouched: that is what passthrough is for.
    expect(call?.headers.get("anthropic-beta")).toBe("future")
  })

  test("relays the upstream body and status unchanged", async () => {
    const body = { id: "msg_1", content: [{ type: "text", text: "hi" }] }
    const { app } = harness({ responses: [() => jsonResponse(200, body)] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(body)
  })

  test("rewrites only the model when the account's alias map renames it", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", {
          provider: "zai",
          apiKey: "sk-zai",
          cipher: CRYPTOR,
          modelAliases: { "claude-opus-5": "glm-4.7" },
        }),
      ],
      responses: [() => jsonResponse(200, {})],
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls[0]?.body).toBe(MESSAGE.replace("claude-opus-5", "glm-4.7"))
  })

  test("serves both OpenAI ingress paths", async () => {
    const openAi = [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })]
    const body = JSON.stringify({ model: "gpt-5", messages: [] })

    for (const [path, suffix] of [
      ["/v1/chat/completions", "/chat/completions"],
      ["/v1/responses", "/responses"],
    ]) {
      const dialect = path === "/v1/responses" ? "openai-responses" : "openai-chat"
      const { app, upstream } = harness({
        accounts: [
          {
            ...openAi[0],
            driver: { ...openAi[0]?.driver, dialect },
          } as RoutableAccount,
        ],
        responses: [() => jsonResponse(200, {})],
      })

      const res = await app.request(path ?? "", post(body, bearer()))
      expect(res.status).toBe(200)
      expect(upstream.calls[0]?.url).toEndWith(suffix ?? "")
    }
  })

  test("streams without buffering: a chunk is readable before the upstream sends the next", async () => {
    const slow = slowStream(["data: one\n\n", "data: two\n\n"])
    const { app } = harness({ responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n")

    slow.release(1)
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toBe("data: two\n\n")

    slow.finish()
    await reader.read()
  })
})

describe("a local endpoint that authenticates nobody", () => {
  const CHAT = JSON.stringify({ model: "llama3.2", messages: [{ role: "user", content: "hi" }] })

  function ollama(credential: string | null): RoutableAccount {
    const base = account("ollama-1", {
      provider: "ollama",
      dialect: "openai-chat",
      baseUrl: "http://ollama.internal:11434/v1",
      cipher: CRYPTOR,
      ...(credential === null ? {} : { apiKey: credential }),
    })
    return credential === null ? { ...base, authMaterial: null } : base
  }

  test("an account holding no credential still serves, with no auth header invented", async () => {
    const { app, upstream, usage } = harness({
      accounts: [ollama(null)],
      responses: [() => jsonResponse(200, { usage: { prompt_tokens: 4, completion_tokens: 6 } })],
    })

    const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
    await res.text()
    await settle()
    const call = upstream.calls[0]

    expect(res.status).toBe(200)
    expect(call?.url).toBe("http://ollama.internal:11434/v1/chat/completions")
    expect(call?.headers.get("authorization")).toBeNull()
    expect(call?.headers.get("x-api-key")).toBeNull()
    // The router key that opened the door never travels onward, credential or not.
    expect(JSON.stringify([...(call?.headers.entries() ?? [])])).not.toContain(KEY)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", provider: "ollama", tokensIn: 4 })
  })

  test("the same account behind a proxy presents the credential it was given", async () => {
    const { app, upstream } = harness({
      accounts: [ollama("proxy-token")],
      responses: [() => jsonResponse(200, {})],
    })

    await app.request("/v1/chat/completions", post(CHAT, bearer()))

    expect(upstream.calls[0]?.headers.get("authorization")).toBe("Bearer proxy-token")
  })

  test("a model the node has not pulled is the client's answer, not another account's turn", async () => {
    const notPulled = {
      error: { message: 'model "llama3.2" not found, try pulling it first', type: "api_error" },
    }
    const { app, upstream, usage } = harness({
      accounts: [ollama(null), ollama(null)],
      responses: [() => jsonResponse(404, notPulled)],
    })

    const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(404)
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows).toHaveLength(1)
  })
})

describe("failover", () => {
  const twoAccounts = [
    account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
    account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
  ]

  const geminiAccount = [account("acct-1", { provider: "gemini", apiKey: "sk-g", cipher: CRYPTOR })]
  const OPENAI_CHAT = JSON.stringify({
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "hello" }],
  })

  test("advances to the next candidate on 429", async () => {
    const { app, upstream } = harness({
      accounts: twoAccounts,
      responses: [
        () => jsonResponse(429, { type: "error", error: { type: "rate_limit_error" } }),
        () => jsonResponse(200, { served: true }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.headers.get("x-api-key")).toBe("sk-two")
  })

  test("advances on 5xx", async () => {
    const { app, upstream } = harness({
      accounts: twoAccounts,
      responses: [() => jsonResponse(503, { error: {} }), () => jsonResponse(200, {})],
    })

    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
  })

  test("does not advance on a 4xx that is bad at every account", async () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "bad" } }
    const { app, upstream } = harness({
      accounts: twoAccounts,
      responses: [() => jsonResponse(400, body), () => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls).toHaveLength(1)
    expect(res.status).toBe(400)
    // The upstream's own error, relayed: the honest answer.
    expect(await res.json()).toEqual(body)
  })

  test("does not advance once a byte has reached the client, even when the stream then breaks", async () => {
    const slow = slowStream(["data: partial\n\n"])
    const { app, upstream, usage } = harness({
      accounts: twoAccounts,
      responses: [() => slow.response, () => jsonResponse(200, { shouldNotBeReached: true })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("partial")

    // The stream breaks mid-response. Replaying a partially delivered stream would give the
    // client a second `message_start` it cannot reconcile, so the request fails honestly instead
    // of silently restarting on the healthy account behind it.
    slow.abort()
    await reader.read().catch(() => undefined)
    await settle()

    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ accountId: "acct-1", streamed: true })
  })

  test("two frames then an upstream break is a truncation relayed to the client, not a retry", async () => {
    const slow = slowStream(["data: one\n\n", "data: two\n\n"])
    const { app, upstream, usage } = harness({
      accounts: twoAccounts,
      responses: [() => slow.response, () => jsonResponse(200, { shouldNotBeReached: true })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("one")
    slow.release(1)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("two")

    // The upstream errors after two frames are already on the wire. The client gets a truncated
    // stream — the honest answer — never a silent restart on the account behind it.
    slow.abort()
    const tail = await reader.read().catch(() => undefined)
    expect(tail === undefined || tail.done).toBe(true)
    await settle()

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.headers.get("x-api-key")).toBe("sk-one")
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ accountId: "acct-1", streamed: true })
  })

  test("fails over when the upstream never answers at all, and the failover is bounded", async () => {
    // A connect failure before any headers exist — `fetch` itself rejects, the same shape a DNS
    // failure or a dropped TCP handshake produces. Unlike a partial stream, no byte has reached
    // the client, so failover is not merely allowed, it is expected.
    const { app, upstream } = harness({
      accounts: twoAccounts,
      responses: [
        () => {
          throw new Error("connect failed")
        },
        () => jsonResponse(200, { served: true }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ served: true })
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.headers.get("x-api-key")).toBe("sk-two")
  })

  test("connect failures on every candidate still stop well short of exhausting the pool", async () => {
    const five = ["a", "b", "c", "d", "e"].map((id) =>
      account(id, { apiKey: `sk-${id}`, cipher: CRYPTOR }),
    )
    const { app, upstream } = harness({
      accounts: five,
      responses: [
        () => {
          throw new Error("connect failed")
        },
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(upstream.calls).toHaveLength(3)
  })

  test("a client that disconnects mid-stream releases the upstream call, with no orphan", async () => {
    const slow = slowStream(["data: partial\n\n"])
    const { app, upstream, usage } = harness({
      accounts: twoAccounts,
      responses: [() => slow.response, () => jsonResponse(200, { shouldNotBeReached: true })],
    })

    const client = new AbortController()
    const res = await app.request("/v1/messages", {
      ...post(MESSAGE, bearer()),
      signal: client.signal,
    })
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("partial")

    const upstreamSignal = upstream.calls[0]?.signal
    expect(upstreamSignal?.aborted).toBe(false)
    // What a real transport does when its request signal fires mid-stream: the connection drops
    // and the body it was reading errors. The stub upstream has no real socket to drop, so this
    // wires the same reaction by hand — the fixture-level equivalent of unplugging the cable.
    upstreamSignal?.addEventListener("abort", () => slow.abort())

    // The client goes away. The upstream call's own signal — the one `fetch` was actually sent
    // with — must fire too, or the request keeps running on the account with nothing left to
    // consume it: an orphaned upstream call charged to no one's response.
    client.abort()
    await reader.read().catch(() => undefined)
    await settle()

    expect(upstreamSignal?.aborted).toBe(true)
    // No second account is ever tried for a client that left mid-stream.
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ accountId: "acct-1", streamed: true })
  })

  test("bounds the attempts well under the candidate count", async () => {
    const five = ["a", "b", "c", "d", "e"].map((id) =>
      account(id, { apiKey: `sk-${id}`, cipher: CRYPTOR }),
    )
    const { app, upstream } = harness({
      accounts: five,
      maxAttempts: 2,
      responses: [() => jsonResponse(500, { error: {} })],
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls).toHaveLength(2)
  })

  test("a spent window is 429 with Retry-After, a dead balance is 402 — never conflated", async () => {
    const limited = harness({
      responses: [() => jsonResponse(429, {}, { "retry-after": "42" })],
    })
    const rateLimited = await limited.app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(rateLimited.status).toBe(429)
    expect(rateLimited.headers.get("Retry-After")).toBe("42")

    const drained = harness({
      responses: [
        () =>
          jsonResponse(400, {
            type: "error",
            error: { type: "invalid_request_error", message: "Your credit balance is too low" },
          }),
      ],
    })
    const outOfCredits = await drained.app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(outOfCredits.status).toBe(402)
  })

  test("a 402 carrying spent rate-limit headers stays exhausted — no timer revives it", async () => {
    // The common shape, and the one that used to lose the distinction: the drained balance answers
    // `402`, and the *same* response still carries the limiter headers every response carries, with
    // the window spent. Folding those in downgraded the account to `cooling_down` and handed the
    // client `429 + Retry-After` for a balance no clock refills (CLAUDE.md non-negotiable 7).
    const { app, health, upstream, usage } = harness({
      responses: [
        () =>
          jsonResponse(
            402,
            {
              type: "error",
              error: { type: "billing_error", message: "credit balance is too low" },
            },
            {
              "x-ratelimit-limit-requests": "1000",
              "x-ratelimit-remaining-requests": "0",
              "x-ratelimit-reset-requests": "60s",
            },
          ),
        () => jsonResponse(200, {}),
      ],
    })

    const first = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(first.status).toBe(402)
    expect(health.stateOf("acct-1").breaker.status).toBe("exhausted")
    // `exhausted` carries no reset **by definition** — that is what makes it un-retryable.
    expect(health.stateOf("acct-1").breaker.cooldownUntil).toBeUndefined()
    // Refused, not discarded: the operator still sees what the limiter said.
    expect(health.stateOf("acct-1").limiterWindows[0]).toMatchObject({
      limiter: "requests",
      remaining: 0,
    })

    const second = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    // 402 again, naming the top-up — never a 429 with a countdown, and never a second upstream call.
    expect(second.status).toBe(402)
    expect(second.headers.get("Retry-After")).toBeNull()
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows.map((row) => row.outcome)).toEqual(["credits_exhausted", "credits_exhausted"])
  })

  test("a 401 carrying spent rate-limit headers still needs a human, not a timer", async () => {
    const { app, health, upstream } = harness({
      responses: [
        () =>
          jsonResponse(
            401,
            { type: "error", error: { type: "authentication_error", message: "invalid key" } },
            { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "60s" },
          ),
        () => jsonResponse(200, {}),
      ],
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    // An `api-key` account whose key was rejected needs the operator to change it: `disabled`, with
    // no cooldown a header could have written over it.
    expect(health.stateOf("acct-1").breaker.status).toBe("disabled")
    expect(health.stateOf("acct-1").breaker.cooldownUntil).toBeUndefined()

    const second = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(second.status).toBe(503)
    expect(second.headers.get("Retry-After")).toBeNull()
    expect(upstream.calls).toHaveLength(1)
  })

  test("Gemini's throttle names billing and is still a cooldown, timed off the body", async () => {
    // The trap this driver exists for: `RESOURCE_EXHAUSTED` covers a per-minute limit *and* a spent
    // free-tier day, and its message says "check your plan and billing details". Read the word and a
    // healthy key is parked at 402 forever. The reset is in `RetryInfo` — Gemini sends no headers.
    const { app, health, usage } = harness({
      accounts: geminiAccount,
      responses: [
        () =>
          jsonResponse(429, {
            error: {
              code: 429,
              message:
                "You exceeded your current quota, please check your plan and billing details.",
              status: "RESOURCE_EXHAUSTED",
              details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" }],
            },
          }),
      ],
    })

    const res = await app.request("/v1/chat/completions", post(OPENAI_CHAT, bearer()))
    await settle()

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("31")
    expect(health.stateOf("acct-1").breaker.status).toBe("cooling_down")
    expect(health.stateOf("acct-1").breaker.cooldownSource).toBe("provider-reported")
    expect(usage.rows[0]?.outcome).toBe("quota_exhausted")
  })

  test("Gemini with billing off is a 402 — the one refusal no clock undoes", async () => {
    const { app, health, usage } = harness({
      accounts: geminiAccount,
      responses: [
        () =>
          jsonResponse(400, {
            error: {
              code: 400,
              message: "Please enable billing on your project in Google AI Studio.",
              status: "FAILED_PRECONDITION",
            },
          }),
      ],
    })

    const res = await app.request("/v1/chat/completions", post(OPENAI_CHAT, bearer()))
    await settle()

    // 402 out of a 400 in: Google never answers 402, so the status alone would read this as a
    // client mistake and keep selecting a credential that cannot serve a request.
    expect(res.status).toBe(402)
    expect(health.stateOf("acct-1").breaker.status).toBe("exhausted")
    expect(usage.rows[0]?.outcome).toBe("credits_exhausted")
  })

  test("marks the failed account so the next request skips it", async () => {
    const { app, health } = harness({
      accounts: twoAccounts,
      responses: [
        () => jsonResponse(429, {}, { "retry-after": "600" }),
        () => jsonResponse(200, {}),
      ],
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(health.stateOf("acct-1").breaker.status).toBe("cooling_down")
    expect(health.stateOf("acct-2").breaker.status).toBe("active")
  })

  /**
   * An account whose stored credential the router cannot read: a rotated `ENCRYPTION_KEY`, or a row
   * written by another deployment. The cipher refuses the envelope, so the attempt dies before a
   * socket is opened.
   */
  const misEncrypted: RoutableAccount = {
    ...account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
    authMaterial: "not-a-credential-envelope",
  }

  test("a mis-encrypted account cannot turn a pool-wide 429 into a 500", async () => {
    const { app, upstream, usage } = harness({
      accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }), misEncrypted],
      responses: [() => jsonResponse(429, {}, { "retry-after": "30" })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    // The chain reports the most actionable failure, not the last one. Candidate 1 said "come back
    // in 30 seconds"; candidate 2 said "this router cannot read its own row", which is true and
    // useless to a caller. Surfacing the second erased the wait and handed back a bare `500`.
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("30")
    // Both attempts are recorded — the broken account is still visible to the operator, it just no
    // longer speaks for the pool. Only one of them reached a socket.
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "upstream_error"])
  })

  test("a mis-encrypted account is still reported when it is all that went wrong", async () => {
    // The fold ranks it last; it must not swallow it. One candidate, nothing more actionable to
    // hold, so the router's own broken state is the honest answer — and the caller's key was fine.
    const { app, upstream } = harness({
      accounts: [misEncrypted],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(500)
    expect(upstream.calls).toHaveLength(0)
  })

  test("a later candidate's bare 5xx cannot erase an earlier one's Retry-After", async () => {
    // Same defect, different mask: a `503` produces no router-shaped verdict, so relaying it lost
    // candidate 1's `429` and the wait that came with it.
    const { app, usage } = harness({
      accounts: twoAccounts,
      responses: [
        () => jsonResponse(429, {}, { "retry-after": "30" }),
        () => jsonResponse(503, { error: { message: "overloaded" } }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("30")
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "upstream_error"])
  })

  test("a drained balance never speaks over an account a clock will revive", async () => {
    const { app } = harness({
      accounts: twoAccounts,
      responses: [
        () => jsonResponse(429, {}, { "retry-after": "30" }),
        () =>
          jsonResponse(402, {
            type: "error",
            error: { type: "billing_error", message: "credit balance is too low" },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    // `402` says "no timer will fix this". With acct-1 back in thirty seconds, that is false about
    // the pool (CLAUDE.md non-negotiable 7 read from the caller's side).
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("30")
  })
})

/**
 * "One request is allowed through as a probe" — `05-routing-and-failover.md`'s words for the
 * half-open transition. `filter.ts` labelled the probe and the policies demoted it, but until the
 * gate existed nothing *admitted* one: the reset instant passing made the recovering account
 * eligible to every waiting request simultaneously, so the backlog that piled up during the
 * cooldown dispatched onto it in the same millisecond and rate-limited it again.
 */
describe("the half-open probe is admitted one at a time", () => {
  const deferred = () => {
    let resolve: (response: Response) => void = () => undefined
    const promise = new Promise<Response>((settleWith) => {
      resolve = settleWith
    })
    return { promise, resolve }
  }

  /** Trips the breaker on the sole account, then advances past the reset it reported. */
  const recovering = async (probeResponse: () => Promise<Response>) => {
    const kit = harness({
      accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })],
      responses: [
        () =>
          jsonResponse(
            429,
            { type: "error", error: { type: "rate_limit_error" } },
            {
              "retry-after": "60",
            },
          ),
        probeResponse,
        // Nothing may reach this. It is scripted so that a router without the gate answers the
        // stampede instead of hanging on the held probe — the difference between a test that fails
        // with an assertion and one that fails with a timeout.
        () => jsonResponse(200, { shouldNotBeReached: true }),
      ],
    })

    expect((await kit.app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(429)
    kit.clock.advance(60_000)
    return kit
  }

  test("one request reaches the recovering account; the backlog behind it waits", async () => {
    const probe = deferred()
    const { app, upstream } = await recovering(() => probe.promise)

    // The probe goes out and stays in flight — the window a real upstream takes to answer, and
    // exactly the window in which a stampede happens.
    const first = app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    const backlog = await Promise.all(
      Array.from({ length: 25 }, () => app.request("/v1/messages", post(MESSAGE, bearer()))),
    )

    // Two calls in total: the one that tripped the breaker, and the single probe.
    expect(upstream.calls).toHaveLength(2)
    for (const response of backlog) {
      // Not a 500, and not a silent queue: the honest "a clock fixes this, come back" (CLAUDE.md
      // non-negotiable 7).
      expect(response.status).toBe(429)
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0)
    }

    probe.resolve(jsonResponse(200, { served: true }))
    expect((await first).status).toBe(200)
  })

  test("a probe that succeeds reopens the account to everyone", async () => {
    const probe = deferred()
    const { app, upstream } = await recovering(() => probe.promise)

    const first = app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()
    probe.resolve(jsonResponse(200, { served: true }))
    expect((await first).status).toBe(200)

    // The account is `active` again, so the gate is irrelevant: no hold outlives the verdict.
    const after = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(after.status).toBe(200)
    expect(upstream.calls).toHaveLength(3)
  })

  test("a probe that fails cools the account down again — nobody inherits the gate", async () => {
    const probe = deferred()
    const { app, upstream } = await recovering(() => probe.promise)

    const first = app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()
    probe.resolve(
      jsonResponse(
        429,
        { type: "error", error: { type: "rate_limit_error" } },
        {
          "retry-after": "120",
        },
      ),
    )
    expect((await first).status).toBe(429)

    const after = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(after.status).toBe(429)
    expect(after.headers.get("Retry-After")).toBe("120")
    expect(upstream.calls).toHaveLength(2)
  })

  test("a healthy account in the same pool is never held out by the gate", async () => {
    // The hold takes one *account* out of one request's chain. A pool with a healthy member has to
    // keep serving at full speed while a convalescing member is tested behind it.
    const { app, upstream, clock } = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
      ],
      selection: { unpooledPolicy: "priority-failover" },
      responses: [
        () =>
          jsonResponse(
            429,
            { type: "error", error: { type: "rate_limit_error" } },
            { "retry-after": "60" },
          ),
        () => jsonResponse(200, { servedBy: "acct-2" }),
      ],
    })

    // acct-1 trips; acct-2 serves the same request.
    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(200)
    clock.advance(60_000)

    // acct-1 is a probe now, and a probe ranks behind a healthy account — so acct-2 takes every
    // one of these and the gate never comes into it.
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => app.request("/v1/messages", post(MESSAGE, bearer()))),
    )

    for (const response of burst) expect(response.status).toBe(200)
    for (const call of upstream.calls.slice(1)) {
      expect(call.headers.get("x-api-key")).toBe("sk-two")
    }
  })
})

describe("scope enforcement", () => {
  test("a key scoped to one account never reaches the other, even when it is healthy", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
      ],
      scope: "accounts",
      accountIds: ["acct-2"],
      responses: [() => jsonResponse(200, {})],
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls[0]?.headers.get("x-api-key")).toBe("sk-two")
  })

  test("an empty scope fails specifically rather than widening", async () => {
    const { app, upstream } = harness({
      accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })],
      scope: "accounts",
      accountIds: [],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("cross-dialect and Agent-SDK egress", () => {
  test("an anthropic request reaches an openai-chat account, converted both ways", async () => {
    const { app, upstream, usage } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      responses: [
        () =>
          jsonResponse(200, {
            id: "chatcmpl-1",
            model: "claude-opus-5",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const body = (await res.json()) as Record<string, unknown>
    await settle()

    expect(res.status).toBe(200)
    // The request went out in the account's dialect, at the account's dialect's path.
    expect(upstream.calls[0]?.url).toContain("/chat/completions")
    const sent = JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
    expect(sent.messages).toEqual([{ role: "user", content: "hello" }])
    // The answer came back in the client's.
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
    })
    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "success" })
  })

  test("a request with no faithful conversion is refused by name, before any upstream call", async () => {
    const { app, upstream } = harness({
      accounts: [account("a", { apiKey: "sk-a", cipher: CRYPTOR })],
      responses: [() => jsonResponse(200, {})],
    })

    const body = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hello" }],
      logprobs: true,
    })
    const res = await app.request("/v1/chat/completions", post(body, bearer()))

    expect(res.status).toBe(400)
    expect(upstream.calls).toHaveLength(0)
    expect(JSON.stringify(await res.json())).toContain("logprobs")
  })

  test("a Claude subscription with no config directory is unservable, not a bad request", async () => {
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub", { configDir: "" })],
      responses: [() => jsonResponse(200, {})],
    })

    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(503)
    // Never addressed over HTTP, so nothing was attempted against `api.anthropic.com`.
    expect(upstream.calls).toHaveLength(0)
  })

  test("a Claude subscription on a router with no SDK transport fails honestly", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(503)
    // The attempt happened and is counted — the account was planned, not refused at the gate.
    expect(usage.rows[0]).toMatchObject({
      accountId: "sub",
      egressMode: "agent-sdk",
      provider: "anthropic-oauth",
    })
  })
})

describe("the Agent-SDK transport", () => {
  const sdkResponse = () =>
    new Response(
      JSON.stringify({
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

  test("serves a subscription account without touching HTTP or a credential", async () => {
    const seen: { configDir: string; model: string }[] = []
    const { app, upstream, usage } = harness({
      accounts: [subscriptionAccount("sub", { configDir: "/data/accounts/sub" })],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: async ({ configDir, model }) => {
        seen.push({ configDir, model })
        return sdkResponse()
      },
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    // No socket was opened: a subscription is never proxied, and the account holds no credential to
    // decrypt in the first place.
    expect(upstream.calls).toHaveLength(0)
    expect(seen).toEqual([{ configDir: "/data/accounts/sub", model: "claude-opus-5" }])
    expect(usage.rows[0]).toMatchObject({
      egressMode: "agent-sdk",
      outcome: "success",
      tokensIn: 7,
      tokensOut: 3,
    })
  })

  test("an OpenAI client reaches a subscription through the ordinary translator", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: async () => sdkResponse(),
    })

    const body = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hello" }],
    })
    const res = await app.request("/v1/chat/completions", post(body, bearer()))
    const payload = await res.json()
    await settle()

    expect(res.status).toBe(200)
    // Rendered SDK → Anthropic once, then Anthropic → openai-chat by the same pair an
    // `anthropic-api` account would have used. No second renderer.
    expect(payload).toMatchObject({ object: "chat.completion" })
    expect(usage.rows[0]?.egressMode).toBe("agent-sdk")
  })

  /** The two-account chain the "did it hop?" assertions below need. */
  const mixedPool = () =>
    [
      subscriptionAccount("sub", { snapshot: { priority: 0 } }),
      account("api-1", { apiKey: "sk-one", cipher: CRYPTOR, snapshot: { priority: 1 } }),
    ] as const

  test("a stale SDK session is replayed on the same account, never handed to another", async () => {
    let calls = 0
    const { app, upstream, usage } = harness({
      accounts: [...mixedPool()],
      selection: { unpooledPolicy: "priority-failover" },
      responses: [() => jsonResponse(200, {})],
      invokeSdk: () => {
        calls += 1
        return calls === 1
          ? Promise.reject(new Error("No conversation found with session ID: sdk-1"))
          : Promise.resolve(sdkResponse())
      },
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    // Recovery in place: the same subprocess transport, twice, and the HTTP account beside it never
    // saw the request (docs/idea/05-routing-and-failover.md, "a stale session is not a failover").
    expect(calls).toBe(2)
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows.map((row) => row.egressMode)).toEqual(["agent-sdk", "agent-sdk"])
  })

  test("the replay is granted exactly once", async () => {
    let calls = 0
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(200, {})],
      invokeSdk: () => {
        calls += 1
        return Promise.reject(new Error("No conversation found with session ID: sdk-1"))
      },
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()

    expect(calls).toBe(2)
    expect(res.status).toBe(503)
  })

  test("a spent subscription window is a 429, never a generic 503", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(200, {})],
      invokeSdk: () => Promise.reject(new Error("Claude AI usage limit reached")),
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(429)
    expect(usage.rows[0]?.outcome).toBe("quota_exhausted")
  })

  test("an expired subscription credential is the account's problem, not the caller's", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(200, {})],
      invokeSdk: () => Promise.reject(new Error("OAuth token has expired")),
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const payload = await res.json()
    await settle()

    // 502, not 401: the presented router key was fine and the operator is the one who must re-login.
    expect(res.status).toBe(502)
    expect(usage.rows[0]?.outcome).toBe("upstream_auth_failed")
    // The SDK's own wording never becomes the client's error body.
    expect(JSON.stringify(payload)).not.toContain("OAuth token")
  })

  test("a failed subscription attempt fails over to the HTTP account beside it", async () => {
    const { app, usage } = harness({
      accounts: [
        subscriptionAccount("sub", { snapshot: { priority: 0 } }),
        account("api-1", { apiKey: "sk-one", cipher: CRYPTOR, snapshot: { priority: 1 } }),
      ],
      // Priority, not the default sticky hash: this asserts an *order*, so the order has to be the
      // operator's rather than a hash's.
      selection: { unpooledPolicy: "priority-failover" },
      responses: [() => jsonResponse(200, { usage: { input_tokens: 1, output_tokens: 2 } })],
      invokeSdk: () => Promise.reject(new Error("the subprocess exited with code 1")),
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(usage.rows.map((row) => row.egressMode)).toEqual(["agent-sdk", "passthrough"])
  })

  test("bytes a subscription account already streamed are never replayed onto the account behind it", async () => {
    const slow = slowStream(["data: partial\n\n"])
    let sdkCalls = 0
    const { app, upstream, usage } = harness({
      accounts: [...mixedPool()],
      selection: { unpooledPolicy: "priority-failover" },
      responses: [() => jsonResponse(200, { shouldNotBeReached: true })],
      invokeSdk: () => {
        sdkCalls += 1
        return Promise.resolve(slow.response)
      },
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("partial")

    // The subprocess's stream breaks after bytes are already on the wire. `chain.ts`'s
    // `markStreamed` (set the instant `outcome.kind === "success"`) makes this structurally
    // unreachable from another account — the loop already returned control before the break — and
    // this is the Agent-SDK transport's proof of the same guarantee `slowStream`'s HTTP sibling
    // asserts above.
    slow.abort()
    await reader.read().catch(() => undefined)
    await settle()

    expect(sdkCalls).toBe(1)
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      accountId: "sub",
      egressMode: "agent-sdk",
      streamed: true,
      outcome: "success",
    })
  })
})

describe("usage accounting", () => {
  test("writes one row per attempt, joined by one correlation id", async () => {
    const { app, usage } = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
      ],
      responses: [
        () => jsonResponse(429, {}),
        () => jsonResponse(200, { usage: { input_tokens: 11, output_tokens: 22 } }),
      ],
    })

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(2)
    const ids = new Set(usage.rows.map((row: UsageRecord) => row.correlationId))
    expect(ids.size).toBe(1)
    expect(usage.rows.map((row) => row.attempt)).toEqual([1, 2])
    expect(usage.rows[0]).toMatchObject({ outcome: "quota_exhausted", accountId: "acct-1" })
    expect(usage.rows[1]).toMatchObject({ outcome: "success", accountId: "acct-2", tokensIn: 11 })
  })

  test("captures cache read and write counts, which explain a small input count", async () => {
    const { app, usage } = harness({
      responses: [
        () =>
          jsonResponse(200, {
            usage: {
              input_tokens: 3,
              output_tokens: 9,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 120,
            },
          }),
      ],
    })

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({ cacheReadTokens: 900, cacheWriteTokens: 120 })
  })

  test("records a row even when nothing was in scope", async () => {
    const { app, usage } = harness({
      accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })],
      scope: "accounts",
      accountIds: [],
      responses: [() => jsonResponse(200, {})],
    })

    await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ accountId: null, outcome: "scope_violation" })
  })

  test("a single passthrough's overhead stays far below the upstream's own delay", async () => {
    // `routerOverheadMs >= 0` alone would pass even if the subtraction regressed to "total time
    // only" — that bug shipped once already (a success attempt's upstream wait was never charged to
    // `upstreamMs`, so overhead absorbed the whole generation) and a unit test with synthetic input
    // didn't catch it (`records.test.ts` only exercises the subtraction itself, never the wiring
    // that feeds it). Driving a real injected delay through the real dispatch loop, and asserting
    // against the budget rather than against "a number exists", is what would have caught it.
    const UPSTREAM_DELAY_MS = 60
    let advance: (ms: number) => void = () => undefined
    const { app, usage, clock } = harness({
      responses: [
        () => {
          advance(UPSTREAM_DELAY_MS)
          return jsonResponse(200, {})
        },
      ],
    })
    advance = clock.advance

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    const row = usage.rows[0]
    expect(row?.latencyMs).toBeGreaterThanOrEqual(UPSTREAM_DELAY_MS)
    // Router overhead is a small fraction of the injected delay, not equal to it — the whole request
    // took at least UPSTREAM_DELAY_MS, and none of that belongs to the router.
    expect(row?.routerOverheadMs).toBeLessThan(UPSTREAM_DELAY_MS / 2)
  })

  test("overhead excludes every upstream span across a multi-attempt failover chain", async () => {
    const UPSTREAM_DELAY_MS = 40
    let advance: (ms: number) => void = () => undefined
    const { app, usage, clock } = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
        account("acct-3", { apiKey: "sk-three", cipher: CRYPTOR }),
      ],
      responses: [
        () => {
          advance(UPSTREAM_DELAY_MS)
          return jsonResponse(503, { error: {} })
        },
        () => {
          advance(UPSTREAM_DELAY_MS)
          return jsonResponse(503, { error: {} })
        },
        () => {
          advance(UPSTREAM_DELAY_MS)
          return jsonResponse(200, {})
        },
      ],
    })
    advance = clock.advance

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(3)
    // 3 * UPSTREAM_DELAY_MS of wall time elapsed across the whole chain — two failed attempts and
    // the one that answered — but none of it is the router's: the final row's overhead must stay
    // small, not accumulate into a multiple of UPSTREAM_DELAY_MS the way it would if a failed
    // attempt's upstream wait went uncounted.
    expect(usage.rows[2]?.routerOverheadMs).toBeLessThan(UPSTREAM_DELAY_MS / 2)
  })

  test("a priced model's usage row carries a non-null cost estimate", async () => {
    const priced = MESSAGE.replace("claude-opus-5", "claude-sonnet-5")
    const { app, usage } = harness({
      responses: [() => jsonResponse(200, { usage: { input_tokens: 11, output_tokens: 22 } })],
    })

    await (await app.request("/v1/messages", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]?.costEstimate).not.toBeNull()
    expect(usage.rows[0]?.costBasis).toBe("metered")
  })

  test("an operator's price override is what the row is priced with", async () => {
    const priced = MESSAGE.replace("claude-opus-5", "claude-sonnet-5")
    // A tenth of the shipped rate, so the assertion cannot pass against the shipped table by
    // coincidence: 11 in + 22 out at $0.3 / $1.5 per Mtok.
    const { app, usage } = harness({
      prices: () => ({
        inputPerMtok: 0.3,
        outputPerMtok: 1.5,
        cacheReadPerMtok: 0,
        cacheWritePerMtok: 0,
      }),
      responses: [() => jsonResponse(200, { usage: { input_tokens: 11, output_tokens: 22 } })],
    })

    await (await app.request("/v1/messages", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]?.costEstimate).toBe("0.000036")
    expect(usage.rows[0]?.costBasis).toBe("metered")
  })
})

describe("observability", () => {
  test("/metrics shows a router_overhead_seconds observation after one request", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, {})] })

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    const res = await app.request("/metrics")
    expect(res.status).toBe(200)
    const body = await res.text()

    // At least one attempt landed in the histogram: the count line is above zero.
    const countLine = body
      .split("\n")
      .find((line) => line.startsWith("router_overhead_seconds_count"))
    expect(countLine).toBeDefined()
    expect(Number(countLine?.split(" ").pop())).toBeGreaterThan(0)
  })
})

describe("GET /v1/models", () => {
  const aliased = [
    account("acct-1", {
      apiKey: "sk-one",
      cipher: CRYPTOR,
      modelAliases: { sonnet: "glm-4.7" },
      // `glm-4.7` is declared as well as aliased to: an account that renames `sonnet` onto a model
      // it does not serve cannot advertise `sonnet`, because a request for it would be filtered
      // out as `model-unsupported` (`services/routing/model.ts`).
      snapshot: { supportedModels: ["claude-opus-5", "glm-4.7"] },
    }),
    account("acct-2", {
      apiKey: "sk-two",
      cipher: CRYPTOR,
      snapshot: { supportedModels: ["gpt-5"] },
    }),
  ]

  test("lists requested-side names in the OpenAI shape for a bearer client", async () => {
    const { app } = harness({ accounts: aliased, responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/models", { headers: bearer() })
    const body = (await res.json()) as { object: string; data: { id: string }[] }

    expect(body.object).toBe("list")
    // `sonnet` *and* `glm-4.7`: the alias is outbound-only, so both names reach the same model.
    expect(body.data.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "glm-4.7",
      "gpt-5",
      "sonnet",
    ])
  })

  test("a declared model set is listed with no alias map at all", () => {
    // The shipped default before the `supported_models` column existed: no aliases anywhere, and
    // therefore an empty catalog on every deployment. `data: []` is what a client's model picker
    // showed, and it is what this asserts can no longer happen.
    const { app } = harness({
      accounts: [
        account("plain", {
          apiKey: "sk-plain",
          cipher: CRYPTOR,
          snapshot: { supportedModels: ["claude-opus-5"] },
        }),
      ],
      responses: [() => jsonResponse(200, {})],
    })

    return app
      .request("/v1/models", { headers: bearer() })
      .then((res) => res.json() as Promise<{ data: { id: string }[] }>)
      .then((body) => {
        expect(body.data.map((model) => model.id)).toEqual(["claude-opus-5"])
      })
  })

  test("an alias onto a model the account does not serve is never advertised", async () => {
    // The listing and the router are one rule: a name here must be a name a request for it is
    // actually served by, or the catalog is promising a 503 nobody could have anticipated.
    const { app } = harness({
      accounts: [
        account("stale", {
          apiKey: "sk-stale",
          cipher: CRYPTOR,
          modelAliases: { sonnet: "glm-4.7" },
          snapshot: { supportedModels: ["glm-4.6"] },
        }),
      ],
      responses: [() => jsonResponse(200, {})],
    })

    const listed = await app.request("/v1/models", { headers: bearer() })
    const body = (await listed.json()) as { data: { id: string }[] }
    expect(body.data.map((model) => model.id)).toEqual(["glm-4.6"])

    // And the probe agrees, which is the property the listing exists to keep.
    expect((await app.request("/v1/models/sonnet", { headers: bearer() })).status).toBe(404)
  })

  test("answers an x-api-key client in the Anthropic shape", async () => {
    const { app } = harness({ accounts: aliased, responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/models", { headers: { "x-api-key": KEY } })
    const body = (await res.json()) as { data: { type: string }[]; has_more: boolean }

    expect(body.has_more).toBe(false)
    expect(body.data[0]?.type).toBe("model")
  })

  test("lists only what the presenting key can reach", async () => {
    const { app } = harness({
      accounts: aliased,
      scope: "accounts",
      accountIds: ["acct-2"],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/models", { headers: bearer() })
    const body = (await res.json()) as { data: { id: string }[] }

    expect(body.data.map((model) => model.id)).toEqual(["gpt-5"])
  })

  test("requires a key like every other data-plane route", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, {})] })
    expect((await app.request("/v1/models")).status).toBe(401)
  })
})

describe("GET /v1/models/:id", () => {
  const aliased = [
    account("acct-1", {
      apiKey: "sk-one",
      cipher: CRYPTOR,
      modelAliases: { sonnet: "glm-4.7" },
      // `modelAliases` also has to land on the routing snapshot, not just the driver — that is
      // what `filterCandidates` actually reads (`resolveModel` is judged after alias mapping),
      // and what the display listing and the reachability check agreeing depends on.
      snapshot: {
        modelAliases: { sonnet: "glm-4.7" },
        supportedModels: ["claude-opus-5", "glm-4.7"],
      },
    }),
  ]

  test("answers a reachable id in the OpenAI shape for a bearer client", async () => {
    const { app } = harness({ accounts: aliased, responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/models/sonnet", { headers: bearer() })
    const body = (await res.json()) as { id: string; object: string; owned_by: string }

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ id: "sonnet", object: "model" })
  })

  test("answers an x-api-key client in the Anthropic shape", async () => {
    const { app } = harness({ accounts: aliased, responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/models/claude-opus-5", { headers: { "x-api-key": KEY } })
    const body = (await res.json()) as { type: string; id: string }

    expect(res.status).toBe(200)
    expect(body).toEqual({ type: "model", id: "claude-opus-5", display_name: "claude-opus-5" })
  })

  test("404s an id no account in the key's scope serves", async () => {
    const { app } = harness({ accounts: aliased, responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/models/no-such-model", {
      headers: { "x-api-key": KEY },
    })
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(404)
    expect(body.error.message).toContain("no-such-model")
  })

  test("404s an id outside the presenting key's scope, never leaking it exists", async () => {
    const { app } = harness({
      accounts: aliased,
      scope: "accounts",
      accountIds: [],
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/models/sonnet", { headers: bearer() })
    expect(res.status).toBe(404)
  })

  test("requires a key like every other data-plane route", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, {})] })
    expect((await app.request("/v1/models/sonnet")).status).toBe(401)
  })

  test("writes no UsageRecord — it is a reachability probe, not a dispatched request", async () => {
    const { app, usage, upstream } = harness({ accounts: aliased, responses: [] })

    const res = await app.request("/v1/models/sonnet", { headers: bearer() })
    await settle()

    expect(res.status).toBe(200)
    // No upstream call either: `selectAccounts` alone decides reachability.
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows).toHaveLength(0)
  })

  test("writes no UsageRecord on a miss either", async () => {
    const { app, usage } = harness({ accounts: aliased, responses: [] })

    await app.request("/v1/models/no-such-model", { headers: bearer() })
    await settle()

    expect(usage.rows).toHaveLength(0)
  })
})

describe("request validation", () => {
  test("a body naming no model is a 400 before any account is selected", async () => {
    const { app, upstream } = harness({ responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/messages", post(JSON.stringify({ messages: [] }), bearer()))

    expect(res.status).toBe(400)
    expect(upstream.calls).toHaveLength(0)
  })
})

/**
 * The configured body ceiling, end to end.
 *
 * The status is the assertion that matters: a `400` here would tell a developer their request was
 * malformed and send them hunting a bad field in a body that was merely long. Both dialects get the
 * refusal in their own error shape, no account is dialed, and no `UsageRecord` is written — nothing
 * was attempted, so there is no attempt to account for.
 */
describe("the request body ceiling", () => {
  const oversized = () =>
    JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "x".repeat(2_048) }],
    })

  test("refuses an oversized body with 413 in the Anthropic error shape", async () => {
    const { app, upstream, usage } = harness({
      responses: [() => jsonResponse(200, {})],
      maxBodyBytes: 512,
    })

    const res = await app.request("/v1/messages", post(oversized(), bearer()))
    const body = await res.json()
    await settle()

    expect(res.status).toBe(413)
    expect(body).toMatchObject({ type: "error", error: { type: "request_too_large" } })
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows).toHaveLength(0)
  })

  test("refuses an oversized body with 413 in the OpenAI error shape", async () => {
    const { app, upstream } = harness({
      responses: [() => jsonResponse(200, {})],
      maxBodyBytes: 512,
    })

    const res = await app.request("/v1/chat/completions", post(oversized(), bearer()))
    const body = await res.json()

    expect(res.status).toBe(413)
    expect(body).toMatchObject({ error: { code: "request_too_large", param: null } })
    expect(upstream.calls).toHaveLength(0)
  })

  test("counts the refusal on router_requests_total under its own outcome", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, {})], maxBodyBytes: 512 })

    await app.request("/v1/messages", post(oversized(), bearer()))
    await settle()

    // Not folded into `client_error`: an operator looking at a spike of these needs to see that the
    // remedy is a bigger ceiling, not a caller sending bad JSON.
    const exposition = await (await app.request("/metrics")).text()
    expect(exposition).toMatch(/router_requests_total\{[^}]*outcome="request_too_large"\} 1/)
  })

  test("serves a body the ceiling admits", async () => {
    const { app, upstream } = harness({
      responses: [() => jsonResponse(200, { usage: { input_tokens: 1, output_tokens: 1 } })],
      maxBodyBytes: 4_096,
    })

    const res = await app.request("/v1/messages", post(oversized(), bearer()))
    await res.text()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
  })

  test("refuses a declared Content-Length over the ceiling without reading the body", async () => {
    const { app, upstream } = harness({
      responses: [() => jsonResponse(200, {})],
      maxBodyBytes: 512,
    })

    // A short body announcing a long one: the header alone is enough to refuse, which is the point
    // — a hostile client never gets the ceiling's worth of buffering out of the router.
    const res = await app.request(
      "/v1/messages",
      post(MESSAGE, { ...bearer(), "content-length": "4294967296" }),
    )

    expect(res.status).toBe(413)
    expect(upstream.calls).toHaveLength(0)
  })
})

/**
 * One pool, three egress modes: a Claude subscription, a cross-dialect account, and an ordinary
 * passthrough account, side by side. Everything above this point proves each transport works in
 * isolation; this proves the pool doesn't care which one served the request — failover walks
 * across them exactly like it walks across three `anthropic-api` accounts, scope stays an
 * intersection with pool membership regardless of which member answers, and every attempt writes
 * its own priced `UsageRecord` whether it succeeded or not.
 */
describe("full-stack integration: one pool, three egress modes", () => {
  const MIXED_POOL_ID = "mixed-pool"

  const mixedPool = (overrides: Partial<PoolSnapshot> = {}): PoolSnapshot => ({
    id: MIXED_POOL_ID,
    name: "mixed",
    policy: "priority-failover",
    members: [
      { accountId: "sub", priority: 0 },
      { accountId: "o", priority: 1 },
      { accountId: "acct-1", priority: 2 },
    ],
    ...overrides,
  })

  const mixedAccounts = () => [
    subscriptionAccount("sub"),
    account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR }),
    account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
  ]

  // A flat rate so every attempt prices, regardless of which provider or model actually answered:
  // the point of the assertion below is that a row is priced, not what number it lands on.
  const flatRate = () => ({
    inputPerMtok: 1,
    outputPerMtok: 2,
    cacheReadPerMtok: 0,
    cacheWritePerMtok: 0,
  })

  test("fails over from the SDK account through the translate account to the passthrough account", async () => {
    let sdkCalls = 0
    const { app, upstream, usage } = harness({
      accounts: mixedAccounts(),
      pools: [mixedPool()],
      scope: "pools",
      poolIds: [MIXED_POOL_ID],
      prices: flatRate,
      invokeSdk: () => {
        sdkCalls += 1
        return Promise.reject(new Error("the subprocess exited with code 1"))
      },
      responses: [
        // The translate account's turn: a plain 429 classifies as rate-limited off the status
        // alone, no provider-specific body needed, and is retryable — the chain keeps going.
        () => jsonResponse(429, {}),
        // The passthrough account's turn: succeeds.
        () => jsonResponse(200, { usage: { input_tokens: 5, output_tokens: 7 } }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(res.status).not.toBe(500)
    expect(sdkCalls).toBe(1)
    expect(upstream.calls).toHaveLength(2)
    expect(usage.rows.map((row) => row.egressMode)).toEqual([
      "agent-sdk",
      "translate",
      "passthrough",
    ])
    expect(usage.rows.map((row) => row.accountId)).toEqual(["sub", "o", "acct-1"])
    // Every attempt is attributed to the pool that produced it, no matter which transport served it.
    expect(usage.rows.map((row) => row.poolId)).toEqual([
      MIXED_POOL_ID,
      MIXED_POOL_ID,
      MIXED_POOL_ID,
    ])
    expect(usage.rows.map((row) => row.outcome)).toEqual([
      "upstream_error",
      "quota_exhausted",
      "success",
    ])
    // A `UsageRecord` per attempt, failures included, and every one of them priced.
    expect(usage.rows).toHaveLength(3)
    expect(usage.rows.every((row) => row.costEstimate !== null)).toBe(true)
  })

  test("a cooling-down translate account is a 429 with Retry-After, never a generic 500", async () => {
    const { app, usage } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      pools: [mixedPool({ members: [{ accountId: "o", priority: 0 }] })],
      scope: "pools",
      poolIds: [MIXED_POOL_ID],
      responses: [() => jsonResponse(429, {}, { "retry-after": "17" })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(429)
    expect(res.status).not.toBe(500)
    expect(res.headers.get("Retry-After")).toBe("17")
    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "quota_exhausted" })
  })

  test("a credit-exhausted translate account is a 402, never retried on a timer", async () => {
    const { app, upstream, usage } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      pools: [mixedPool({ members: [{ accountId: "o", priority: 0 }] })],
      scope: "pools",
      poolIds: [MIXED_POOL_ID],
      responses: [() => jsonResponse(402, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(402)
    expect(res.status).not.toBe(500)
    // One attempt, not a retry loop: `credits-exhausted` is clock-independent, so nothing about a
    // second call here would ever be a timer firing.
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "credits_exhausted" })
  })

  test("an empty pool scope is a 403 and reaches none of the three accounts", async () => {
    let sdkCalls = 0
    const { app, upstream, usage } = harness({
      accounts: mixedAccounts(),
      pools: [mixedPool()],
      scope: "pools",
      poolIds: [],
      invokeSdk: () => {
        sdkCalls += 1
        return Promise.resolve(jsonResponse(200, {}))
      },
      responses: [() => jsonResponse(200, {})],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(403)
    expect(res.status).not.toBe(500)
    expect(sdkCalls).toBe(0)
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows[0]).toMatchObject({ accountId: null, outcome: "scope_violation" })
  })

  test("scope stays an intersection with pool membership no matter which member would answer", async () => {
    let sdkCalls = 0
    // A fourth account, healthier and higher priority than every pool member, but never a member
    // of `mixed-pool` — the key's scope is the pool, so this account is not a candidate at all,
    // regardless of what its own health or priority would otherwise earn it.
    const outside = account("outside", {
      apiKey: "sk-outside",
      cipher: CRYPTOR,
      snapshot: { priority: -1 },
    })

    const { app, upstream, usage } = harness({
      accounts: [...mixedAccounts(), outside],
      pools: [mixedPool()],
      scope: "pools",
      poolIds: [MIXED_POOL_ID],
      invokeSdk: () => {
        sdkCalls += 1
        return Promise.reject(new Error("the subprocess exited with code 1"))
      },
      responses: [
        () => jsonResponse(429, {}),
        () => jsonResponse(200, { usage: { input_tokens: 1, output_tokens: 1 } }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(sdkCalls).toBe(1)
    // Two upstream calls, both against pool members: `o` (translate, fails) then `acct-1`
    // (passthrough, succeeds) — `outside` is never dialed even though it would outrank both.
    expect(upstream.calls).toHaveLength(2)
    expect(usage.rows.map((row) => row.accountId)).toEqual(["sub", "o", "acct-1"])
    expect(usage.rows.some((row) => row.accountId === "outside")).toBe(false)
  })
})
