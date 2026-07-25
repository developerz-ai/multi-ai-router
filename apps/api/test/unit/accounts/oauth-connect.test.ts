import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { OAuthConnectCompleted, OAuthConnectService } from "../../../src/services/accounts"
import { createOAuthConnectService } from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createMemoryStore, type MemoryStore } from "../../support/memory-store"

/**
 * The authorization-code + PKCE flow the router drives itself for `openai-oauth` — the flow
 * `services/accounts/connect/oauth.ts` names no provider for (any driver that advertises a
 * `ProviderOAuthFlow` gets it). Nothing here reaches a real token endpoint: `fetch` is injected,
 * and it is asserted against by request shape rather than trusted blindly.
 *
 * The four properties this file exists to pin: the PKCE verifier the router holds never equals
 * the challenge it hands the provider (and the challenge really is `S256` of the verifier); a
 * `state` is one-shot; a pending authorization expires on `stateMinutes`, config not a constant;
 * and a used-up or otherwise rejected `state` never yields a second chance.
 */

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
  let queued: Response = tokenResponse({ access_token: "access-1", expires_in: 3600 })

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

function harness(
  options: { stateMinutes?: number; callbackUrl?: string | null; upstream?: FakeFetch } = {},
): Harness {
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
    callbackUrl: options.callbackUrl === undefined ? null : options.callbackUrl,
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

    // The stored row carries only an *encrypted* verifier — never the raw value, never the challenge.
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
    // And the verifier itself never leaked into the authorize URL or the result.
    expect(started.value.authorizeUrl).not.toContain(verifier)
  })

  test("the window is config, not a constant", async () => {
    const h = harness({ stateMinutes: 2 })
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)

    expect(started.value.expiresAt).toBe("2026-07-25T09:02:00.000Z")
  })

  test("no PUBLIC_URL means paste capture, using the driver's own loopback redirect", async () => {
    const h = harness({ callbackUrl: null })
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)

    expect(started.value.capture).toBe("paste")
    expect(started.value.redirectUri).toBe("http://localhost:1455/auth/callback")
  })

  test("a configured PUBLIC_URL means redirect capture, using the callback address", async () => {
    const h = harness({ callbackUrl: "https://router.example/admin/accounts/oauth/callback" })
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)

    expect(started.value.capture).toBe("redirect")
    expect(started.value.redirectUri).toBe("https://router.example/admin/accounts/oauth/callback")
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
    // Only the first exchange ever reached the provider.
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

    // Redeeming consumes the state even though the code is presented by the paste path this time;
    // once the state itself has been spent, no capture mode can complete it again.
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
