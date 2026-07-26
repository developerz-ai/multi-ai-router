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
