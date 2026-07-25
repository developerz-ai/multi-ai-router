import { describe, expect, test } from "bun:test"
import type { UsageRecord } from "../../src/services/usage"
import { account, jsonResponse, newRouterKey, slowStream } from "../unit/dataplane/fixtures"
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

describe("failover", () => {
  const twoAccounts = [
    account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
    account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
  ]

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

  test("a Claude subscription is refused as unservable, not as a bad request", async () => {
    const { app } = harness({
      accounts: [
        { ...account("sub"), driver: { ...account("sub").driver, provider: "anthropic-oauth" } },
      ],
      responses: [() => jsonResponse(200, {})],
    })

    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(503)
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

  test("carries the router's own overhead, separate from upstream time", async () => {
    const { app, usage } = harness({ responses: [() => jsonResponse(200, {})] })

    await (await app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    expect(usage.rows[0]?.routerOverheadMs).toBeGreaterThanOrEqual(0)
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
      snapshot: { supportedModels: ["claude-opus-5"] },
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
    // `sonnet`, not `glm-4.7`: the alias is outbound-only.
    expect(body.data.map((model) => model.id)).toEqual(["claude-opus-5", "gpt-5", "sonnet"])
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

describe("request validation", () => {
  test("a body naming no model is a 400 before any account is selected", async () => {
    const { app, upstream } = harness({ responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/messages", post(JSON.stringify({ messages: [] }), bearer()))

    expect(res.status).toBe(400)
    expect(upstream.calls).toHaveLength(0)
  })
})
