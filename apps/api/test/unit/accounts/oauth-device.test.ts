import { describe, expect, test } from "bun:test"
import {
  createDeviceConnectService,
  createOAuthConnectService,
} from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createMemoryStore } from "../../support/memory-store"

/**
 * Device-code sign-in against a mocked auth.openai.com. Endpoints and shapes are codex-rs's
 * (`login/src/device_code_auth.rs`); nothing here reaches the real issuer.
 */
const NOW = new Date("2026-10-04T12:00:00.000Z")
const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
const POLL_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const DEVICE_AUTH_ID = "dev-auth-SECRET-123"
const ISSUED_CODE = "ac_issued_SECRET"
const ISSUED_VERIFIER = "verifier_SECRET_abc"
const ACCESS = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.s`

type Route = (request: Request, body: string) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function harness(poll: Route[] = [() => json({}, 403)]) {
  const store = createMemoryStore()
  const clock = { now: NOW }
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(5) })
  const calls: { url: string; body: string }[] = []
  let polls = 0
  const fetch = async (request: Request) => {
    const body = await request.clone().text()
    calls.push({ url: request.url, body })
    if (request.url === USERCODE_URL) {
      return json({ device_auth_id: DEVICE_AUTH_ID, user_code: "ABCD-1234", interval: "5" })
    }
    if (request.url === POLL_URL) {
      const route = poll[Math.min(polls, poll.length - 1)]
      polls += 1
      if (route === undefined) throw new Error("no poll route")
      return route(request, body)
    }
    if (request.url === TOKEN_URL) {
      return json({ access_token: ACCESS, refresh_token: "refresh_SECRET", expires_in: 3600 })
    }
    throw new Error(`unexpected upstream ${request.url}`)
  }
  const deps = {
    accounts: store.accounts,
    states: store.oauthStates,
    cipher,
    audit: createAuditRecorder(store.audit),
    stateMinutes: 10,
    fetch,
    exchangeTimeoutMs: 1_000,
    now: () => clock.now,
    refreshCatalogAfterMutation: async () => {},
  }
  return {
    store,
    clock,
    calls,
    device: createDeviceConnectService(deps),
    oauth: createOAuthConnectService(deps),
    account: async () =>
      (await store.accounts.create({ label: "codex-1", provider: "openai-oauth" })).id,
  }
}

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`)
  return result.value
}

const advance = (h: { clock: { now: Date } }, seconds: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + seconds * 1_000)
}

const SECRETS = [DEVICE_AUTH_ID, ISSUED_CODE, ISSUED_VERIFIER, ACCESS, "refresh_SECRET"]

describe("device-code sign-in", () => {
  test("begin asks the issuer for a code and shows only the user code and the page", async () => {
    const h = harness()
    const id = await h.account()
    const started = value(await h.device.begin(id, "connect"))
    expect(started).toMatchObject({
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
      expiresAt: "2026-10-04T12:10:00.000Z",
    })
    expect(JSON.parse(h.calls[0]?.body ?? "{}")).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    })
    expect(JSON.stringify(started)).not.toContain(DEVICE_AUTH_ID)
    const row = h.store.rows.oauthStates.at(-1)
    expect(row?.redirectUri).toBe("https://auth.openai.com/deviceauth/callback")
    expect(row?.nonce ?? "").not.toContain(DEVICE_AUTH_ID)
  })

  test("pending, then approved: one poll per interval, then the code is exchanged and stored", async () => {
    const h = harness([
      () => json({ error: "pending" }, 403),
      () =>
        json({
          authorization_code: ISSUED_CODE,
          code_verifier: ISSUED_VERIFIER,
          code_challenge: "c",
        }),
    ])
    const id = await h.account()
    value(await h.device.begin(id, "connect"))

    expect(value(await h.device.status(id)).status).toBe("waiting")
    expect(value(await h.device.status(id)).status).toBe("waiting")
    expect(h.calls.filter((c) => c.url === POLL_URL)).toHaveLength(1)
    expect(JSON.parse(h.calls[1]?.body ?? "{}")).toEqual({
      device_auth_id: DEVICE_AUTH_ID,
      user_code: "ABCD-1234",
    })

    advance(h, 5)
    const done = value(await h.device.status(id))
    expect(done).toEqual({
      status: "connected",
      completed: { accountId: id, mode: "connect", connected: true, capture: "device" },
    })
    const exchange = new URLSearchParams(h.calls.find((c) => c.url === TOKEN_URL)?.body ?? "")
    expect(exchange.get("code")).toBe(ISSUED_CODE)
    expect(exchange.get("code_verifier")).toBe(ISSUED_VERIFIER)
    expect(exchange.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback")
    const row = await h.store.accounts.findById(id)
    expect(row?.authMaterial).not.toBeNull()
    expect(row?.status).toBe("active")
    expect(h.store.rows.audit.at(-1)?.detail).toMatchObject({ capture: "device" })
    expect(value(await h.device.status(id)).status).toBe("connected")
    for (const secret of SECRETS) expect(JSON.stringify(done)).not.toContain(secret)
  })

  test("denied by the issuer is final and spends the attempt", async () => {
    const h = harness([() => json({ error: "access_denied" }, 400)])
    const id = await h.account()
    value(await h.device.begin(id, "connect"))
    expect(value(await h.device.status(id))).toEqual({ status: "denied", accountId: id })
    advance(h, 30)
    expect(value(await h.device.status(id)).status).toBe("denied")
    expect(h.calls.filter((c) => c.url === POLL_URL)).toHaveLength(1)
    expect((await h.store.accounts.findById(id))?.authMaterial).toBeNull()
  })

  test("past the TTL it is expired, and the issuer is not asked", async () => {
    const h = harness()
    const id = await h.account()
    value(await h.device.begin(id, "connect"))
    advance(h, 10 * 60 + 1)
    expect(value(await h.device.status(id))).toEqual({ status: "expired", accountId: id })
    expect(h.calls.filter((c) => c.url === POLL_URL)).toHaveLength(0)
  })

  test("an attempt superseded mid-poll cannot write credentials", async () => {
    let release: (response: Response) => void = () => {}
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const h = harness([() => held])
    const id = await h.account()
    value(await h.device.begin(id, "connect"))
    const polling = h.device.status(id)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    value(await h.oauth.begin(id, "connect"))
    release(json({ authorization_code: ISSUED_CODE, code_verifier: ISSUED_VERIFIER }))
    expect(value(await polling).status).toBe("expired")
    expect(h.calls.some((c) => c.url === TOKEN_URL)).toBe(false)
    expect((await h.store.accounts.findById(id))?.authMaterial).toBeNull()
  })

  test("a pasted code cannot redeem a device attempt", async () => {
    const h = harness()
    const id = await h.account()
    value(await h.device.begin(id, "connect"))
    const state = h.store.rows.oauthStates.at(-1)?.state ?? ""
    const refused = await h.oauth.complete(id, `stolen#${state}`)
    expect(refused).toMatchObject({ ok: false, failure: { code: "state_rejected" } })
    expect(h.calls.some((c) => c.url === TOKEN_URL)).toBe(false)
  })

  test("an issuer with device login disabled says so", async () => {
    const h = harness()
    const id = await h.account()
    // 404 on the usercode endpoint — codex's "device code login is not enabled".
    const disabled = createDeviceConnectService({
      accounts: h.store.accounts,
      states: h.store.oauthStates,
      cipher: createCredentialCipher({ key: new Uint8Array(32).fill(5) }),
      audit: createAuditRecorder(h.store.audit),
      stateMinutes: 10,
      fetch: async () => json({}, 404),
      exchangeTimeoutMs: 1_000,
      now: () => NOW,
      refreshCatalogAfterMutation: async () => {},
    })
    expect(await disabled.begin(id, "connect")).toMatchObject({
      ok: false,
      failure: { code: "device_unavailable" },
    })
  })

  test("an account whose provider has no device flow is refused by name", async () => {
    const h = harness()
    const other = (await h.store.accounts.create({ label: "or", provider: "openrouter" })).id
    expect(await h.device.begin(other, "connect")).toMatchObject({ ok: false })
  })
})
