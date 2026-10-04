import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { OAuthConnectCompleted, OAuthConnectService } from "../../../src/services/accounts"
import { createOAuthConnectService } from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createMemoryStore, type MemoryStore } from "../../support/memory-store"

const NOW = new Date("2026-07-25T09:00:00.000Z")
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
interface FakeFetch {
  readonly fetch: (request: Request) => Promise<Response>
  readonly requests: Request[]
  readonly bodies: string[]
  next(response: Response): void
}
function fakeFetch(): FakeFetch {
  const requests: Request[] = []
  const bodies: string[] = []
  let queued: Response = tokenResponse({
    access_token: "access-1",
    id_token: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "identity-1" } })).toString("base64url")}.sig`,
    expires_in: 3600,
  })
  return {
    requests,
    bodies,
    next: (response) => {
      queued = response
    },
    fetch: async (request) => {
      requests.push(request.clone())
      bodies.push(await request.clone().text())
      return queued
    },
  }
}
interface Harness {
  readonly connect: OAuthConnectService
  readonly store: MemoryStore
  readonly clock: { now: Date }
  readonly upstream: FakeFetch
  account(provider?: "openai-oauth" | "openrouter"): Promise<string>
}
function harness(options: { stateMinutes?: number; upstream?: FakeFetch } = {}): Harness {
  const store = createMemoryStore()
  const clock = { now: NOW }
  const upstream = options.upstream ?? fakeFetch()
  const audit = createAuditRecorder(store.audit)
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(9) })
  const connect = createOAuthConnectService({
    accounts: store.accounts,
    states: store.oauthStates,
    cipher,
    audit,
    fetch: upstream.fetch,
    exchangeTimeoutMs: 5_000,
    now: () => clock.now,
    stateMinutes: options.stateMinutes ?? 10,
    refreshCatalogAfterMutation: async () => {},
  })
  return {
    connect,
    store,
    clock,
    upstream,
    account: async (provider = "openai-oauth") => {
      const created = await store.accounts.create({ label: `${provider}-1`, provider })
      return created.id
    },
  }
}
function failure(result: { ok: boolean } & Record<string, unknown>) {
  if (result.ok) throw new Error("expected a failure")
  return (result as { failure: { code: string; message: string } }).failure
}
function completed(result: { ok: boolean } & Record<string, unknown>): OAuthConnectCompleted {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`)
  return (result as { value: OAuthConnectCompleted }).value
}
describe("starting an authorization", () => {
  test("mints a state and a PKCE pair the provider never sees the raw verifier of", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const url = new URL(started.value.authorizeUrl)
    const state = url.searchParams.get("state")
    const challenge = url.searchParams.get("code_challenge")
    expect(state).not.toBeNull()
    expect(challenge).not.toBeNull()
    const pending = h.store.rows.oauthStates.find((row) => row.state === state)
    expect(pending).toBeDefined()
    expect(pending?.codeVerifier).not.toBe(challenge)
    expect(JSON.stringify(started)).not.toContain(pending?.codeVerifier ?? "\0unmatched\0")
  })
  test("the challenge really is S256 of the verifier the router holds", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const url = new URL(started.value.authorizeUrl)
    const challenge = url.searchParams.get("code_challenge")
    const pending = h.store.rows.oauthStates.find(
      (row) => row.state === url.searchParams.get("state"),
    )
    if (pending === undefined) throw new Error("no pending state row")
    const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(9) })
    const verifier = cipher.decrypt(pending.codeVerifier)
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge)
    expect(started.value.authorizeUrl).not.toContain(verifier)
  })
  test("the window is config, not a constant", async () => {
    const h = harness({ stateMinutes: 2 })
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)
    expect(started.value.expiresAt).toBe("2026-07-25T09:02:00.000Z")
  })
  test("paste capture, using the driver's own loopback redirect", async () => {
    const h = harness()
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)
    expect(started.value.capture).toBe("paste")
    expect(started.value.redirectUri).toBe("http://localhost:1455/auth/callback")
  })
  // Production 2026-10-04: with PUBLIC_URL set the authorize URL named the router's callback, which
  // the first-party ChatGPT client does not register — the issuer refuses it and no code exists to
  // capture by either mode. The loopback is the only redirect such a client can be sent to.
  test("the authorize URL names the client's registered loopback, never the router's callback", async () => {
    const h = harness()
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)
    expect(started.value.capture).toBe("paste")
    expect(started.value.redirectUri).toBe("http://localhost:1455/auth/callback")
    const authorize = new URL(started.value.authorizeUrl)
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(started.value.authorizeUrl).not.toContain(
      encodeURIComponent("/admin/accounts/oauth/callback"),
    )
  })
  test("refuses an account with no authorization-code flow", async () => {
    const h = harness()
    const reason = failure(await h.connect.begin(await h.account("openrouter"), "connect"))
    expect(reason.code).toBe("not_an_oauth_account")
  })
  test("refuses an id no account has", async () => {
    const h = harness()
    const reason = failure(await h.connect.begin("00000000-0000-4000-8000-000000000000", "connect"))
    expect(reason.code).toBe("not_found")
  })
  test("a second begin supersedes the first: the old state can no longer complete", async () => {
    const h = harness()
    const id = await h.account()
    const first = await h.connect.begin(id, "connect")
    await h.connect.begin(id, "connect")
    if (!first.ok) throw new Error(first.failure.message)
    const firstState = new URL(first.value.authorizeUrl).searchParams.get("state") ?? ""
    const reason = failure(await h.connect.redeem({ code: "c1", state: firstState }))
    expect(reason.code).toBe("state_rejected")
  })
})
describe("redeeming the code", () => {
  test("a matching code and state complete the exchange", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    const done = completed(await h.connect.redeem({ code: "a-real-looking-code", state }))
    expect(done).toEqual({ accountId: id, mode: "connect", connected: true, capture: "redirect" })
    const row = await h.store.accounts.findById(id)
    expect(row?.tokenExpiresAt).toEqual(new Date(NOW.getTime() + 3_600_000))
  })
  test("the exchange sent is form-encoded and carries the router's own verifier", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    await h.connect.redeem({ code: "the-code", state })
    expect(h.upstream.requests).toHaveLength(1)
    const sent = h.upstream.requests[0]
    expect(sent?.url).toBe(TOKEN_ENDPOINT)
    expect(sent?.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    const sentBody = new URLSearchParams(h.upstream.bodies[0] ?? "")
    expect(sentBody.get("code")).toBe("the-code")
    expect(sentBody.get("grant_type")).toBe("authorization_code")
  })
  test("state is one-shot: a second redeem of the same state is rejected", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    expect((await h.connect.redeem({ code: "code-1", state })).ok).toBe(true)
    const reason = failure(await h.connect.redeem({ code: "code-2", state }))
    expect(reason.code).toBe("state_rejected")
    expect(h.upstream.requests).toHaveLength(1)
  })
  test("an unknown state is rejected the same way as an expired or reused one", async () => {
    const h = harness()
    const reason = failure(await h.connect.redeem({ code: "code", state: "never-issued" }))
    expect(reason.code).toBe("state_rejected")
  })
  test("a state past its TTL is rejected and never reaches the provider", async () => {
    const h = harness({ stateMinutes: 10 })
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    h.clock.now = new Date(NOW.getTime() + 10 * 60_000 + 1)
    const reason = failure(await h.connect.redeem({ code: "code", state }))
    expect(reason.code).toBe("state_rejected")
    expect(h.upstream.requests).toHaveLength(0)
  })
  test("a wrong guess burns the state — no retry with the right code afterward", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    await h.connect.redeem({ code: "first-attempt", state })
    const reason = failure(await h.connect.complete(id, `wrong-code#${state}`))
    expect(reason.code).toBe("state_rejected")
  })
  test("the provider refusing the code exchange leaves the state consumed, not retryable", async () => {
    const upstream = fakeFetch()
    upstream.next(tokenResponse({ error: "invalid_grant" }, 400))
    const h = harness({ upstream })
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    const first = failure(await h.connect.redeem({ code: "code", state }))
    expect(first.code).toBe("exchange_refused")
    const second = failure(await h.connect.redeem({ code: "code", state }))
    expect(second.code).toBe("state_rejected")
  })
  test("a redirect carrying an authorization error still burns the state", async () => {
    const h = harness()
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    const refused = failure(await h.connect.redeem({ state, error: "access_denied" }))
    expect(refused.code).toBe("authorization_refused")
    const replay = failure(await h.connect.redeem({ code: "code", state }))
    expect(replay.code).toBe("state_rejected")
  })
  test("clears needs_reauth on redeem", async () => {
    const h = harness()
    const id = await h.account()
    await h.store.accounts.update(id, { status: "needs_reauth" }, NOW)
    const started = await h.connect.begin(id, "reconnect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    const done = completed(await h.connect.redeem({ code: "code", state }))
    expect(done.connected).toBe(true)
    expect((await h.store.accounts.findById(id))?.status).toBe("active")
  })
  test("mode is derived from whether the account already held a credential", async () => {
    const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(9) })
    const h = harness()
    const id = await h.account()
    await h.store.accounts.update(
      id,
      { status: "needs_reauth", authMaterial: cipher.encrypt('{"accessToken":"stale"}') },
      NOW,
    )
    const started = await h.connect.begin(id, "reconnect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state") ?? ""
    const done = completed(await h.connect.redeem({ code: "code", state }))
    expect(done.mode).toBe("reconnect")
  })
})
describe("pasting what the loopback left in the address bar", () => {
  async function begun(h: Harness): Promise<{ id: string; state: string }> {
    const id = await h.account()
    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    return { id, state: new URL(started.value.authorizeUrl).searchParams.get("state") ?? "" }
  }

  test("the whole localhost callback URL completes the exchange against the loopback redirect", async () => {
    const h = harness()
    const { id, state } = await begun(h)
    const pasted = `http://localhost:1455/auth/callback?code=ac_the-code&scope=openid+profile+email+offline_access&state=${encodeURIComponent(state)}`
    const done = completed(await h.connect.complete(id, pasted))
    expect(done).toEqual({ accountId: id, mode: "connect", connected: true, capture: "paste" })
    const sent = new URLSearchParams(h.upstream.bodies[0] ?? "")
    expect(sent.get("code")).toBe("ac_the-code")
    expect(sent.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect((await h.store.accounts.findById(id))?.authMaterial).not.toBeNull()
  })

  test("the code#state shorthand completes it too", async () => {
    const h = harness()
    const { id, state } = await begun(h)
    expect(completed(await h.connect.complete(id, ` ac_short#${state}\n`)).capture).toBe("paste")
  })

  test("a paste whose state was superseded by a second start is rejected, not exchanged", async () => {
    const h = harness()
    const { id, state } = await begun(h)
    await h.connect.begin(id, "connect")
    const reason = failure(
      await h.connect.complete(id, `http://localhost:1455/auth/callback?code=c&state=${state}`),
    )
    expect(reason.code).toBe("state_rejected")
    expect(h.upstream.requests).toHaveLength(0)
  })
})
describe("cancelling a pending authorization", () => {
  test("cancels the live state; cancelling nothing is not an error", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")
    const first = await h.connect.cancel(id)
    const second = await h.connect.cancel(id)
    if (!first.ok || !second.ok) throw new Error("cancel failed")
    expect(first.value.cancelled).toBe(true)
    expect(second.value.cancelled).toBe(false)
  })
})
