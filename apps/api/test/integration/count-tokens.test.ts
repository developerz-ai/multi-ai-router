import { describe, expect, test } from "bun:test"
import { account, jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, MESSAGE, post, settle } from "./harness"

/**
 * `POST /v1/messages/count_tokens`, end to end: real Hono, real middleware, real routing, **mocked
 * upstreams**.
 *
 * Claude Code calls this before a turn to decide when to compact, so a router that 404s it is a
 * router that client half-works against. The rules this suite pins down:
 *
 *  - it is an ordinary data-plane request — same key, same scope, same failover chain;
 *  - it is **passthrough or nothing**. A count is a statement about one provider's tokenizer, so an
 *    account that cannot answer is dropped from the chain rather than approximated for;
 *  - the `input_tokens` it returns is a measurement of a prompt nobody ran, so it never lands on a
 *    `UsageRecord` and is never priced.
 */

const COUNT = JSON.stringify({
  model: "claude-opus-5",
  messages: [{ role: "user", content: "how many tokens is this" }],
})

const COUNTED = () => jsonResponse(200, { input_tokens: 4531 })

describe("passthrough", () => {
  test("forwards the body byte for byte to Anthropic's own suffix", async () => {
    const { app, upstream } = harness({ responses: [COUNTED] })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ input_tokens: 4531 })
    const call = upstream.calls[0]
    expect(call?.url).toBe("https://upstream.test/v1/messages/count_tokens")
    expect(call?.method).toBe("POST")
    expect(call?.body).toBe(COUNT)
    // The router key never leaves; the account's credential is what the upstream sees.
    expect(call?.headers.get("x-api-key")).toBe("sk-one")
    expect(call?.headers.get("authorization")).toBeNull()
  })

  test("accepts the Anthropic key form too, and answers in the Anthropic error shape", async () => {
    const { app } = harness({ responses: [COUNTED] })

    expect(
      (await app.request("/v1/messages/count_tokens", post(COUNT, { "x-api-key": KEY }))).status,
    ).toBe(200)

    const unauthorized = await app.request("/v1/messages/count_tokens", post(COUNT))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    })
  })

  test("applies the account's alias map, because the count must name the model upstream bills", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", {
          provider: "anthropic-compatible",
          apiKey: "sk-compat",
          cipher: CRYPTOR,
          modelAliases: { "claude-opus-5": "some-other-model" },
        }),
      ],
      responses: [COUNTED],
    })

    await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    const sent = JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
    expect(sent.model).toBe("some-other-model")
  })

  test("relays the upstream's own refusal instead of inventing a number", async () => {
    // An Anthropic-compatible vendor that never implemented the endpoint. Its 404 is the honest
    // answer and it reaches the client unchanged.
    const { app } = harness({
      accounts: [
        account("compat", {
          provider: "anthropic-compatible",
          apiKey: "sk-compat",
          cipher: CRYPTOR,
        }),
      ],
      responses: [() => jsonResponse(404, { type: "error", error: { type: "not_found_error" } })],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { type: "not_found_error" } })
  })
})

describe("routing", () => {
  test("fails over exactly like inference does", async () => {
    const { app, upstream, usage } = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
      ],
      responses: [() => jsonResponse(429, {}), COUNTED],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.url).toContain("/count_tokens")
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "success"])
  })

  test("a mixed pool answers off the one account that can count", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub"), account("api", { apiKey: "sk-api", cipher: CRYPTOR })],
      responses: [COUNTED],
      invokeSdk: async ({ configDir }) => {
        invoked.push(configDir)
        return jsonResponse(200, {})
      },
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(200)
    expect(upstream.calls[0]?.headers.get("x-api-key")).toBe("sk-api")
    // The subscription was dropped at planning, never attempted — no subprocess, ever.
    expect(invoked).toEqual([])
  })

  test("scope still decides the candidate set", async () => {
    const { app, upstream } = harness({
      accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })],
      scope: "accounts",
      accountIds: [],
      responses: [COUNTED],
    })

    expect((await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("accounts that cannot count", () => {
  test("a Claude-subscription-only pool is refused by name, never with a made-up number", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [COUNTED],
      invokeSdk: async ({ configDir }) => {
        invoked.push(configDir)
        return jsonResponse(200, {})
      },
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string; type: string } }

    expect(res.status).toBe(503)
    expect(body.error.type).toBe("overloaded_error")
    expect(body.error.message).toContain("Claude Agent SDK")
    // Nothing was forged at api.anthropic.com and no subprocess was launched to guess a count.
    expect(upstream.calls).toHaveLength(0)
    expect(invoked).toEqual([])
  })

  test("an openai-only pool is refused too, rather than counted with the wrong tokenizer", async () => {
    const { app, upstream } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      responses: [COUNTED],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(503)
    expect(body.error.message).toContain("openai-chat")
    expect(upstream.calls).toHaveLength(0)
  })

  test("inference over that same pool still works — only the count is narrowed", async () => {
    const { app } = harness({
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

    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(200)
  })
})

describe("an account that could count, held back by its health", () => {
  test("is a 429 with Retry-After, not a 503 saying no account can count", async () => {
    // The pool holds exactly one account that can count and one that never could. The countable one
    // cools down; the other is dropped at planning, so the chain empties. Reporting the *plan's*
    // reason there tells the operator to add an Anthropic account they already have, and hands the
    // client a permanent-looking refusal for a condition a clock fixes — the `cooling_down` vs
    // `exhausted` conflation non-negotiable 7 forbids, one layer up.
    const { app, usage } = harness({
      accounts: [
        account("anth", { apiKey: "sk-anth", cipher: CRYPTOR }),
        account("oai", { provider: "openai-api", apiKey: "sk-oai", cipher: CRYPTOR }),
      ],
      responses: [() => jsonResponse(429, {}, { "retry-after": "37" })],
    })

    // First request cools the countable account down.
    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string; type: string } }
    await settle()

    expect(res.status).toBe(429)
    expect(res.status).not.toBe(503)
    expect(res.headers.get("Retry-After")).toBe("37")
    expect(body.error.type).toBe("rate_limit_error")
    // Names the account the operator would wait on, not the one that was never able to count.
    expect(body.error.message).toContain("anth")
    expect(body.error.message).not.toContain("cannot count tokens")
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "quota_exhausted"])
  })

  test("inference over that same cooling account still reports the same 429", async () => {
    const { app } = harness({
      accounts: [account("anth", { apiKey: "sk-anth", cipher: CRYPTOR })],
      responses: [() => jsonResponse(429, {}, { "retry-after": "37" })],
    })

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("37")
  })

  test("but a pool that genuinely cannot count still gets the named 503", async () => {
    // The regression guard for the fix above: an OpenAI account that is perfectly healthy must
    // still surface the operation gap, not be reinterpreted as a capacity problem.
    const { app } = harness({
      accounts: [account("oai", { provider: "openai-api", apiKey: "sk-oai", cipher: CRYPTOR })],
      responses: [COUNTED],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBeNull()
    expect(body.error.message).toContain("cannot count tokens")
  })
})

describe("accounting", () => {
  test("counts as a request, but never as tokens spent", async () => {
    const { app, usage } = harness({ responses: [COUNTED] })

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(1)
    // `input_tokens: 4531` measured a prompt nobody ran. Recording it would price a question as a
    // completion and inflate every spend report that sums the column.
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "passthrough",
      accountId: "acct-1",
      model: "claude-opus-5",
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: null,
    })
  })

  test("records no cost even on a model the price table knows", async () => {
    // The guard the assertion above cannot make: `claude-opus-5` is priced nowhere, so a row for it
    // comes back `null` whether or not anything decided it should. `claude-sonnet-5` *is* in the
    // shipped table, and zeroed counts against a known rate price as `metered $0.000000` — a free
    // completion, which is not what happened. Nothing was completed at all.
    const priced = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    })
    const { app, usage } = harness({ responses: [COUNTED] })

    await (await app.request("/v1/messages/count_tokens", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({
      model: "claude-sonnet-5",
      outcome: "success",
      costEstimate: null,
      costBasis: "unknown",
    })
  })

  test("does not price a count that failed either", async () => {
    const priced = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    })
    const { app, usage } = harness({
      responses: [() => jsonResponse(500, { type: "error", error: { type: "api_error" } })],
    })

    await (await app.request("/v1/messages/count_tokens", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({ costEstimate: null, costBasis: "unknown" })
  })

  test("an ordinary completion on that same model is still priced", async () => {
    // The other half of the rule: this is a narrowing of `count_tokens`, not of pricing.
    const { app, usage } = harness({
      responses: [
        () =>
          jsonResponse(200, {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 11, output_tokens: 22 },
          }),
      ],
    })

    const message = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    })
    await (await app.request("/v1/messages", post(message, bearer()))).text()
    await settle()

    expect(usage.rows[0]?.costBasis).toBe("metered")
    expect(usage.rows[0]?.costEstimate).not.toBeNull()
  })

  test("writes a row even when no account could count", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [COUNTED],
    })

    await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    await settle()

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      accountId: null,
      outcome: "no_healthy_account",
      errorClass: "NoHealthyAccountError",
    })
  })
})
