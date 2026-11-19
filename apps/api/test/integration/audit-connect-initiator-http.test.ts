import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AdminAuthGuardService } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "../../src/routes/admin/accounts"
import { oauthCallbackRoutes } from "../../src/routes/admin/oauth-callback"
import {
  type AccountsService,
  type ClaudeConnectService,
  createConnectService,
  createDeviceConnectService,
  createOAuthConnectService,
  type DiscoverModelsService,
  OAUTH_CALLBACK_PATH,
  type RecheckService,
  type TestNowService,
} from "../../src/services/accounts"
import { createAuditRecorder } from "../../src/services/admin"
import { ADMIN_API_TOKEN_ACTOR } from "../../src/services/admin-auth"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import type { AppEnv } from "../../src/types"
import { createMemoryStore } from "../support/memory-store"
import { pasteOnlyFlow } from "../support/oauth-flows"
import { silentLogger } from "../support/silent-logger"

/**
 * multi-ai-router#455: an account connect names whoever STARTED it, wherever it completes. The start
 * goes through the real guard and the real accounts route, so the initiator stored on the
 * `oauth_states` row is the one the guard captured — not a hand-set context.
 */

const TOKEN = "t".repeat(48)
const OPERATOR = "a@example.test"
const NOW = new Date("2026-11-19T12:00:00.000Z")
const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
const POLL_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
const TOKEN_URL = "https://auth.openai.com/oauth/token"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const ID_TOKEN = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.s`

/** The issuer: a user code, an approved poll, and a token set — nothing real. */
async function issuer(request: Request): Promise<Response> {
  if (request.url === USERCODE_URL)
    return json({ device_auth_id: "dev-auth-1", user_code: "ABCD-1234", interval: "5" })
  if (request.url === POLL_URL)
    return json({ authorization_code: "ac_1", code_verifier: "cv_1", code_challenge: "c" })
  if (request.url === TOKEN_URL)
    return json({ access_token: ID_TOKEN, id_token: ID_TOKEN, expires_in: 3600 })
  throw new Error(`unexpected upstream ${request.url}`)
}

function guardService(): AdminAuthGuardService {
  return {
    authenticate: async () => ({
      id: "session-a",
      username: OPERATOR,
      csrfToken: "csrf",
      createdAtMs: NOW.getTime(),
      lastSeenAtMs: NOW.getTime(),
      idleExpiryMs: NOW.getTime() + 3_600_000,
      absoluteExpiryMs: NOW.getTime() + 86_400_000,
    }),
    assertCsrf: () => {},
  }
}

function harness() {
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(3) })
  const base = {
    accounts: store.accounts,
    states: store.oauthStates,
    cipher,
    audit: createAuditRecorder(store.audit, silentLogger()),
    stateMinutes: 10,
    fetch: issuer,
    exchangeTimeoutMs: 1_000,
    now: () => NOW,
    refreshCatalogAfterMutation: async () => {},
  }
  const deviceFirst = createConnectService({
    accounts: store.accounts,
    claude: {} as ClaudeConnectService,
    oauth: createOAuthConnectService(base),
    device: createDeviceConnectService(base),
  })
  const pasteOnly = createConnectService({
    accounts: store.accounts,
    claude: {} as ClaudeConnectService,
    oauth: createOAuthConnectService({ ...base, flowFor: pasteOnlyFlow }),
    device: createDeviceConnectService(base),
  })
  const mount = (connect: typeof pasteOnly) => {
    const app = new Hono<AppEnv>()
    app.use("*", requestId())
    app.use("*", requestLogger(silentLogger()))
    app.onError(errorHandler(silentLogger(), null))
    app.route(
      ADMIN_ACCOUNTS_BASE_PATH,
      adminAccountRoutes({
        guard: adminAuth(guardService(), false, TOKEN, 1),
        service: {} as AccountsService,
        recheck: {} as RecheckService,
        testNow: {} as TestNowService,
        discoverModels: {} as DiscoverModelsService,
        connect,
      }),
    )
    // Mounted as `app.ts` mounts it: at the root, without the guard.
    app.route("/", oauthCallbackRoutes({ connect }))
    return app
  }
  return { store, redirectApp: mount(pasteOnly), deviceApp: mount(deviceFirst) }
}

/** Operator A, from the console, declaring `x`, behind one trusted proxy. */
const AS_A = {
  "x-csrf-token": "csrf",
  "x-admin-actor": "x",
  "user-agent": "console/1.0",
  "x-forwarded-for": "6.6.6.6, 203.0.113.7",
}

async function startAs(app: Hono<AppEnv>, path: string): Promise<Record<string, unknown>> {
  const response = await app.request(path, { method: "POST", headers: AS_A })
  const text = await response.text()
  expect({ path, status: response.status, text }).toEqual({ path, status: 200, text })
  return JSON.parse(text) as Record<string, unknown>
}

async function redirectBack(app: Hono<AppEnv>, authorizeUrl: unknown) {
  const state = new URL(String(authorizeUrl)).searchParams.get("state")
  if (state === null) throw new Error("authorize URL carried no state")
  const response = await app.request(
    `${OAUTH_CALLBACK_PATH}?${new URLSearchParams({ code: "ac_redirect", state })}`,
  )
  expect(response.status).toBe(200)
}

const INITIATOR = {
  actor: OPERATOR,
  actorKind: "session",
  actorSays: "x",
  clientIp: "203.0.113.7",
  userAgent: "console/1.0",
}

describe("an account connect names who started it (multi-ai-router#455)", () => {
  test("redirect callback: account.connected carries A, A's declared name and A's address", async () => {
    const { store, redirectApp } = harness()
    const account = await store.accounts.create({ label: "codex", provider: "openai-oauth" })

    const started = await startAs(redirectApp, `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect`)
    await redirectBack(redirectApp, started.authorizeUrl)

    const rows = store.rows.audit.filter((row) => row.kind === "account.connected")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject(INITIATOR)
    expect(rows[0]?.requestId).not.toBeNull()
  })

  test("a reconnect through the callback: account.reauthorized carries the initiator too", async () => {
    const { store, redirectApp } = harness()
    const account = await store.accounts.create({ label: "codex", provider: "openai-oauth" })
    const path = `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}`
    await redirectBack(redirectApp, (await startAs(redirectApp, `${path}/connect`)).authorizeUrl)
    await redirectBack(redirectApp, (await startAs(redirectApp, `${path}/reconnect`)).authorizeUrl)

    const rows = store.rows.audit.filter((row) => row.kind === "account.reauthorized")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject(INITIATOR)
  })

  test("device flow: the row names A even when another caller's poll completes it", async () => {
    const { store, deviceApp } = harness()
    const account = await store.accounts.create({ label: "codex", provider: "openai-oauth" })
    const path = `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect/device`
    await startAs(deviceApp, path)

    // A different holder — the shared admin token from a script — happens to poll it home.
    const polled = await deviceApp.request(path, {
      headers: { authorization: `Bearer ${TOKEN}`, "x-admin-actor": "poller" },
    })
    expect(((await polled.json()) as { status: string }).status).toBe("connected")

    const rows = store.rows.audit.filter((row) => row.kind === "account.connected")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject(INITIATOR)
    expect(rows[0]?.actor).not.toBe(ADMIN_API_TOKEN_ACTOR)
  })
})
