import { describe, expect, test } from "bun:test"
import { opaqueAccountRef } from "../../src/errors/account-ref"
import type { RouterErrorObject } from "../../src/errors/router-object"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

/**
 * "Account X needs reconnecting", as the client tool receives it: an account that lost its login
 * (`needs_reauth`) is named — by its operator label, with the console page that fixes it — in the
 * sentence a person reads, in `error.router.reconnect`, and in `x-router-reconnect-needed` on a
 * served answer whose body stays the upstream's own
 * (docs/idea/06-protocol-translation.md#reconnect-needed).
 */

const PUBLIC_URL = "https://router.example.com/"
const ACCOUNTS_PAGE = "https://router.example.com/accounts"

const lostLogin = (id: string, label: string) =>
  account(id, {
    provider: "openai-oauth",
    cipher: CRYPTOR,
    snapshot: { label, status: "needs_reauth" },
  })
const healthy = account("acct-ok", { apiKey: "sk-ok", cipher: CRYPTOR })

const CHAT = JSON.stringify({
  model: "claude-opus-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
})

interface ErrorEnvelope {
  readonly type?: string
  readonly error: {
    readonly type: string
    readonly message: string
    readonly code?: string | null
    readonly router: RouterErrorObject
  }
}

describe("no account can serve, and one needs reconnecting", () => {
  const SENTENCE =
    "no eligible account: Codex (sebi) needs re-auth. Reconnect needed: account Codex (sebi) (openai-oauth) lost its login — a router admin must reconnect it at https://router.example.com/accounts"

  test("Anthropic ingress: the 503 sentence names the account and the console page", async () => {
    const { app } = harness({
      accounts: [lostLogin("acct-codex", "Codex (sebi)")],
      responses: [],
      publicUrl: PUBLIC_URL,
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    expect(res.status).toBe(503)
    const body = (await res.json()) as ErrorEnvelope
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("overloaded_error")
    expect(body.error.message).toBe(SENTENCE)
    expect(body.error.router.wall).toBe("human")
    expect(body.error.router.reconnect).toEqual([
      {
        account: opaqueAccountRef("acct-codex"),
        label: "Codex (sebi)",
        provider: "openai-oauth",
        url: ACCOUNTS_PAGE,
      },
    ])
    expect(res.headers.get("x-router-reconnect-needed")).toBe("Codex%20(sebi)")
  })

  test("OpenAI ingress: the same sentence and object in the OpenAI shape", async () => {
    const { app } = harness({
      accounts: [lostLogin("acct-codex", "Codex (sebi)")],
      responses: [],
      publicUrl: PUBLIC_URL,
    })

    const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
    await settle()

    expect(res.status).toBe(503)
    const body = (await res.json()) as ErrorEnvelope
    expect(body.error.type).toBe("server_error")
    expect(body.error.code).toBe("no_healthy_account")
    expect(body.error.message).toBe(SENTENCE)
    expect(body.error.router.reconnect.map((entry) => entry.url)).toEqual([ACCOUNTS_PAGE])
    expect(res.headers.get("x-router-reconnect-needed")).toBe("Codex%20(sebi)")
  })

  test("without PUBLIC_URL the sentence points at the console's Accounts page by name", async () => {
    const { app } = harness({
      accounts: [lostLogin("a", "max-1"), lostLogin("b", "max-2")],
      responses: [],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await settle()

    const body = (await res.json()) as ErrorEnvelope
    expect(body.error.message).toBe(
      "no eligible account: max-1 needs re-auth, max-2 needs re-auth. Reconnect needed: accounts max-1 (openai-oauth), max-2 (openai-oauth) lost their login — a router admin must reconnect them in the router console (Accounts page)",
    )
    expect(body.error.router.reconnect.map((entry) => entry.url)).toEqual([null, null])
  })
})

describe("served worse: the healthy account answered, or failed, while one needs reconnecting", () => {
  test("a success keeps the upstream's body and says so only in a header", async () => {
    const { app } = harness({
      accounts: [lostLogin("acct-codex", "Codex (sebi)"), healthy],
      responses: [() => jsonResponse(200, { ok: true })],
      publicUrl: PUBLIC_URL,
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get("x-router-account")).toBe(opaqueAccountRef("acct-ok"))
    expect(res.headers.get("x-router-reconnect-needed")).toBe("Codex%20(sebi)")
  })

  test("a success with every account logged in carries no such header", async () => {
    const { app } = harness({
      accounts: [healthy],
      responses: [() => jsonResponse(200, { ok: true })],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))

    expect(res.status).toBe(200)
    expect(res.headers.get("x-router-reconnect-needed")).toBeNull()
  })

  for (const [path, request] of [
    ["/v1/messages", MESSAGE],
    ["/v1/chat/completions", CHAT],
  ] as const) {
    test(`${path}: the survivor's 429 also names the account that could have served`, async () => {
      const { app } = harness({
        accounts: [lostLogin("acct-codex", "Codex (sebi)"), healthy],
        responses: [
          () =>
            jsonResponse(
              429,
              { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
              { "retry-after": "42" },
            ),
        ],
        publicUrl: PUBLIC_URL,
      })

      const res = await app.request(path, post(request, bearer()))
      await settle()

      expect(res.status).toBe(429)
      const body = (await res.json()) as ErrorEnvelope
      expect(body.error.message).toEndWith(
        ". Reconnect needed: account Codex (sebi) (openai-oauth) lost its login — a router admin must reconnect it at https://router.example.com/accounts",
      )
      expect(body.error.router.wall).toBe("clock")
      expect(body.error.router.reconnect.map((entry) => entry.label)).toEqual(["Codex (sebi)"])
      expect(res.headers.get("x-router-reconnect-needed")).toBe("Codex%20(sebi)")
    })
  }
})
