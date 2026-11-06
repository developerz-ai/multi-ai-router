import { describe, expect, test } from "bun:test"
import { opaqueAccountRef } from "../../src/errors/account-ref"
import type { RouterErrorObject } from "../../src/errors/router-object"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, STREAMED_MESSAGE, settle } from "./harness"

/**
 * The router's machine-readable contract on the wire, end to end: `error.router` in every ingress
 * dialect and the `x-router-*` headers on every answer. developerz.ai reads these instead of the
 * sentences (docs/idea/06-protocol-translation.md#the-router-error-object).
 */

const twoAccounts = [
  account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
  account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
]

const CHAT = JSON.stringify({
  model: "claude-opus-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
})

const RESPONSES = JSON.stringify({ model: "claude-opus-5", input: "hello" })

/** One request per ingress dialect, each served by Anthropic-dialect accounts. */
const INGRESS = [
  { path: "/v1/messages", body: MESSAGE, dialect: "anthropic" },
  { path: "/v1/chat/completions", body: CHAT, dialect: "openai-chat" },
  { path: "/v1/responses", body: RESPONSES, dialect: "openai-responses" },
] as const

const rateLimited = () =>
  jsonResponse(
    429,
    { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    { "retry-after": "42" },
  )

async function routerOf(res: Response): Promise<RouterErrorObject> {
  const body = (await res.json()) as { error: { router: RouterErrorObject } }
  return body.error.router
}

describe("error.router — every ingress dialect", () => {
  for (const ingress of INGRESS) {
    describe(ingress.dialect, () => {
      test("an exhausted chain of 429s: clock wall, the attempts, the accounts, the wait", async () => {
        const { app } = harness({
          accounts: twoAccounts,
          selection: { unpooledPolicy: "priority-failover" },
          responses: [rateLimited, rateLimited],
        })

        const res = await app.request(ingress.path, post(ingress.body, bearer()))
        await settle()

        expect(res.status).toBe(429)
        const router = await routerOf(res)
        expect(router).toEqual({
          wall: "clock",
          scope: "account",
          retryable: true,
          reset_at: router.reset_at,
          reset_source: router.reset_source,
          retry_after_s: Number(res.headers.get("retry-after")),
          accounts: [
            { account: opaqueAccountRef("acct-1"), state: "quota_exhausted", reset_at: null },
            { account: opaqueAccountRef("acct-2"), state: "quota_exhausted", reset_at: null },
          ],
          pools: [],
          signal: "anthropic:rate_limit_error",
          attempts: 2,
          request_id: res.headers.get("x-request-id"),
        })
        expect(router.retry_after_s).toBe(42)
        expect(router.reset_at).not.toBeNull()
        expect(res.headers.get("x-router-attempts")).toBe("2")
        expect(res.headers.get("x-router-request-id")).toBe(router.request_id)
      })

      test("a pool already cooling: pool scope, each member by its filter reason", async () => {
        const { app } = harness({ responses: [rateLimited] })
        await app.request(ingress.path, post(ingress.body, bearer()))
        await settle()

        const res = await app.request(ingress.path, post(ingress.body, bearer()))

        expect(res.status).toBe(429)
        const router = await routerOf(res)
        expect(router).toMatchObject({
          wall: "clock",
          scope: "pool",
          retryable: true,
          reset_source: "provider-reported",
          signal: "cooling-down",
          attempts: 0,
          accounts: [
            {
              account: opaqueAccountRef("acct-1"),
              state: "cooling-down",
              reset_at: router.reset_at,
            },
          ],
        })
        expect(router.reset_at).not.toBeNull()
        expect(res.headers.get("x-router-attempts")).toBe("0")
      })

      test("a drained balance: human wall, no wait, no reset", async () => {
        const { app } = harness({
          responses: [
            () =>
              jsonResponse(400, {
                type: "error",
                error: { type: "invalid_request_error", message: "Your credit balance is too low" },
              }),
          ],
        })

        const res = await app.request(ingress.path, post(ingress.body, bearer()))

        expect(res.status).toBe(402)
        expect(await routerOf(res)).toMatchObject({
          wall: "human",
          scope: "account",
          retryable: false,
          reset_at: null,
          reset_source: null,
          retry_after_s: null,
          attempts: 1,
        })
      })

      test("an empty key scope: scope wall at 403", async () => {
        const { app, upstream } = harness({ responses: [], scope: "accounts", accountIds: [] })

        const res = await app.request(ingress.path, post(ingress.body, bearer()))

        expect(res.status).toBe(403)
        expect(await routerOf(res)).toMatchObject({
          wall: "scope",
          scope: "key",
          retryable: false,
          signal: "no-account-in-scope",
          attempts: 0,
        })
        expect(upstream.calls).toHaveLength(0)
      })

      test("a revoked key still names its request id", async () => {
        const { app } = harness({ responses: [] })

        const res = await app.request(ingress.path, post(ingress.body))

        expect(res.status).toBe(401)
        const router = await routerOf(res)
        expect(router).toMatchObject({ wall: "human", scope: "key", retryable: false })
        expect(router.request_id).toBe(res.headers.get("x-router-request-id"))
      })
    })
  }

  test("the sentence beside it is unchanged", async () => {
    const { app } = harness({ responses: [rateLimited] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const body = (await res.json()) as { error: { type: string; message: string } }

    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toBe("upstream rate limited (anthropic:rate_limit_error)")
  })
})

describe("x-router-* headers on every answer", () => {
  test("a served answer names its model, provider, account and attempts", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { ok: true })] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-router-served-model")).toBe("claude-opus-5")
    expect(res.headers.get("x-router-provider")).toBe("anthropic-api")
    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("acct-1"))
    expect(res.headers.get("x-router-attempts")).toBe("1")
    expect(res.headers.get("x-router-request-id")).toBe(res.headers.get("x-request-id"))
    expect(res.headers.get("x-request-id")).not.toBeNull()
  })

  test("a stream carries them at its headers, before the first byte, still unbuffered", async () => {
    const slow = slowStream(["data: one\n\n"])
    const { app } = harness({ responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(STREAMED_MESSAGE, bearer()))

    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("acct-1"))
    expect(res.headers.get("x-router-attempts")).toBe("1")
    expect(res.headers.get("x-router-request-id")).not.toBeNull()
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()
    slow.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n")
    slow.finish()
    await reader.read()
  })

  test("a failover names the account that answered, and counts both attempts", async () => {
    const { app } = harness({
      accounts: twoAccounts,
      selection: { unpooledPolicy: "priority-failover" },
      responses: [rateLimited, () => jsonResponse(200, { ok: true })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("acct-2"))
    expect(res.headers.get("x-router-attempts")).toBe("2")
  })

  test("the served model is the one the upstream was asked for, after the alias map", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", {
          apiKey: "sk-one",
          cipher: CRYPTOR,
          modelAliases: { "claude-opus-5": "claude-opus-5-20261101" },
        }),
      ],
      responses: [() => jsonResponse(200, { ok: true })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(upstream.calls).toHaveLength(1)
    expect(res.headers.get("x-router-served-model")).toBe("claude-opus-5-20261101")
  })

  test("an upstream's own error, relayed, names the account that said it", async () => {
    const { app } = harness({
      responses: [
        () =>
          jsonResponse(400, {
            type: "error",
            error: { type: "invalid_request_error", message: "messages: field required" },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(400)
    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("acct-1"))
    expect(res.headers.get("x-router-provider")).toBe("anthropic-api")
    expect(res.headers.get("x-router-attempts")).toBe("1")
    expect(res.headers.get("x-router-request-id")).not.toBeNull()
  })

  test("a router-authored error names no account but still counts its attempts", async () => {
    const { app } = harness({ responses: [rateLimited] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(429)
    expect(res.headers.get("x-router-account")).toBeNull()
    expect(res.headers.get("x-router-attempts")).toBe("1")
  })
})
