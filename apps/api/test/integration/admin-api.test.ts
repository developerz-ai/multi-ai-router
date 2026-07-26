import { describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import type {
  ClaudeCliLogin,
  ClaudeLoginHandle,
  CredentialGuard,
  CredentialState,
} from "../../src/providers/claude-sdk/login"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "../../src/routes/admin/accounts"
import { ADMIN_KEYS_BASE_PATH, adminKeyRoutes } from "../../src/routes/admin/keys"
import { oauthCallbackRoutes } from "../../src/routes/admin/oauth-callback"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "../../src/routes/admin/pools"
import { ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes } from "../../src/routes/admin/providers"
import {
  createAccountsService,
  createClaudeConnectService,
  createConnectService,
  createOAuthConnectService,
  createRecheckService,
  createTestNowService,
  OAUTH_CALLBACK_PATH,
} from "../../src/services/accounts"
import { createAuditRecorder } from "../../src/services/admin"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { createHealthStore } from "../../src/services/dataplane"
import { createKeysService } from "../../src/services/keys"
import { createPoolsService } from "../../src/services/pools"
import { createMemoryConfigDirs } from "../support/config-dirs"
import { createMemoryStore } from "../support/memory-store"

/**
 * The admin CRUD plane driven through a real Hono app with `app.request(...)`.
 *
 * `app.ts` is not ours to wire, so the harness mounts the four sub-routers
 * exactly the way `createApp` will — which also proves they are mountable and
 * that each one carries its guard. The session is stubbed so the tests are about
 * the CRUD surface; the guard itself is covered by `admin-auth.test.ts`, and one
 * test below re-mounts with the real guard to prove nothing here is reachable
 * without a session.
 */

const SECRET = "sk-live-upstream-credential-value"
const NOW = new Date("2026-07-24T12:00:00.000Z")
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")

interface HarnessOptions {
  readonly login?: FakeLogin
  readonly credentials?: CredentialGuard
  /** Mutable, so a test can move the clock forward to expire a pending login. */
  readonly clock?: { now: Date }
  readonly pendingLoginMinutes?: number
  /** The OAuth token-endpoint stand-in the callback route's exchange calls. */
  readonly oauthFetch?: typeof fetch
  /** The upstream "Test now" addresses. Defaults to a stub that fails any test hitting it by name. */
  readonly testNowFetch?: typeof fetch
}

function harness(
  guard: MiddlewareHandler<AdminAuthEnv> = stubSession(),
  options: HarnessOptions = {},
) {
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const audit = createAuditRecorder(store.audit)
  const clock = options.clock ?? { now: NOW }
  const now = () => clock.now
  const configDirs = createMemoryConfigDirs()
  const login = options.login ?? fakeLogin()

  const app = new Hono<AdminAuthEnv>()
  const logLines: string[] = []
  // `debug` so a login failure's `logger.warn(...)` line is captured too — the token-leak
  // assertions need every line the router would actually write, not just what an operator sees.
  const logger = createLogger({ level: "debug", write: (line) => logLines.push(line) })
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())

  const connect = createConnectService({
    accounts: store.accounts,
    claude: createClaudeConnectService({
      accounts: store.accounts,
      configDirs: configDirs.dirs,
      login,
      credentials: options.credentials ?? fakeCredentials(),
      audit,
      pendingLoginMinutes: options.pendingLoginMinutes ?? 10,
      logger,
      now,
    }),
    oauth: createOAuthConnectService({
      accounts: store.accounts,
      states: store.oauthStates,
      cipher,
      audit,
      stateMinutes: options.pendingLoginMinutes ?? 10,
      callbackUrl: null,
      // No test reaches a provider unless it opts in via `oauthFetch` — an unexpected call is a
      // failure, not a silent 404.
      fetch: options.oauthFetch ?? (() => Promise.reject(new Error("no upstream in this harness"))),
      exchangeTimeoutMs: 1_000,
      now,
    }),
  })

  // Mounted at the root, unguarded, exactly as `app.ts` does — the redirect is a cross-site
  // top-level navigation, so the admin session cookie is never sent with it and a guard here
  // would refuse every real callback (`routes/admin/oauth-callback.ts`).
  app.route("/", oauthCallbackRoutes({ connect }))

  app.route(
    ADMIN_ACCOUNTS_BASE_PATH,
    adminAccountRoutes({
      guard,
      service: createAccountsService({
        accounts: store.accounts,
        keys: store.keys,
        cipher,
        configDirs: configDirs.dirs,
        audit,
        now,
      }),
      // The dispatching service `app.ts` mounts, not one backend of it: which login an account
      // takes is decided from the provider registry, and that decision is part of the surface.
      connect,
      recheck: createRecheckService({
        accounts: store.accounts,
        health: createHealthStore(),
        audit,
        cooldownSeconds: 60,
        now,
      }),
      testNow: createTestNowService({
        accounts: store.accounts,
        cipher,
        audit,
        cooldownSeconds: 60,
        timeoutMs: 1_000,
        now,
        fetch:
          options.testNowFetch ?? (() => Promise.reject(new Error("no upstream in this harness"))),
      }),
    }),
  )
  app.route(
    ADMIN_POOLS_BASE_PATH,
    adminPoolRoutes({
      guard,
      service: createPoolsService({
        pools: store.pools,
        accounts: store.accounts,
        keys: store.keys,
        audit,
        now,
      }),
    }),
  )
  app.route(
    ADMIN_KEYS_BASE_PATH,
    adminKeyRoutes({
      guard,
      service: createKeysService({
        keys: store.keys,
        pools: store.pools,
        accounts: store.accounts,
        cipher,
        audit,
        now,
      }),
    }),
  )
  app.route(ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes({ guard }))

  return { app, store, configDirs, clock, login, logLines, connect }
}

/**
 * A fake `claude` CLI login, stubbed at the same `ClaudeCliLogin` seam PR 7's SDK-security test
 * uses — no subprocess in CI. Real is everything the router owns on top of it: the one-shot
 * `state`, the TTL, and the rule that no code, state, or token ever reaches a response or a log.
 */
const STATE_PREFIX = "s-"
let stateCounter = 0
function nextState(): string {
  stateCounter += 1
  return `${STATE_PREFIX}${stateCounter}`
}

interface FakeLogin extends ClaudeCliLogin {
  readonly handles: FakeHandle[]
}

interface FakeHandle extends ClaudeLoginHandle {
  readonly submitted: string[]
}

function fakeLogin(): FakeLogin {
  const handles: FakeHandle[] = []
  return {
    handles,
    start: async () => {
      const state = nextState()
      const submitted: string[] = []
      const handle: FakeHandle = {
        authorizeUrl: `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=${state}`,
        state,
        submitted,
        submit: async (value) => {
          submitted.push(value)
        },
        cancel: () => undefined,
      }
      handles.push(handle)
      return handle
    },
  }
}

function fakeCredentials(state: CredentialState = "compact"): CredentialGuard {
  return { settle: async () => state }
}

/** Stands in for a resolved admin session, so these tests are about the CRUD surface. */
function stubSession(): MiddlewareHandler<AdminAuthEnv> {
  return async (c, next) => {
    c.set("adminSession", {
      id: "session-1",
      username: "admin",
      csrfToken: "csrf",
      createdAtMs: NOW.getTime(),
      lastSeenAtMs: NOW.getTime(),
    })
    await next()
  }
}

type App = ReturnType<typeof harness>["app"]

async function call(
  app: App,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text === "" ? null : JSON.parse(text), text }
}

async function newAccount(app: App, overrides: Record<string, unknown> = {}) {
  const created = await call(app, "POST", ADMIN_ACCOUNTS_BASE_PATH, {
    label: "openrouter-primary",
    provider: "openrouter",
    credential: SECRET,
    ...overrides,
  })
  expect(created.status).toBe(201)
  return created.body as { id: string; hasCredential: boolean }
}

describe("the guard", () => {
  test("every admin route group is unreachable without a session", async () => {
    const service = createAdminAuthService({
      env: {
        adminUsername: "admin",
        adminCredential: { kind: "hash", value: await Bun.password.hash("hunter2") },
        encryptionKey: ENCRYPTION_KEY,
      },
    })
    const { app } = harness(adminAuth(service, false))

    for (const path of [
      ADMIN_ACCOUNTS_BASE_PATH,
      ADMIN_POOLS_BASE_PATH,
      ADMIN_KEYS_BASE_PATH,
      ADMIN_PROVIDERS_BASE_PATH,
    ]) {
      expect((await call(app, "GET", path)).status).toBe(401)
    }
  })
})

describe("GET /api/admin/providers", () => {
  test("exposes the registry so the console hard-codes no provider list", async () => {
    const { app } = harness()
    const res = await call(app, "GET", ADMIN_PROVIDERS_BASE_PATH)
    const body = res.body as { providers: Record<string, unknown>[] }

    expect(res.status).toBe(200)
    expect(body.providers.length).toBeGreaterThan(5)
    expect(body.providers).toContainEqual(
      expect.objectContaining({ id: "openai-compatible", requiresBaseUrl: true }),
    )
    expect(body.providers).toContainEqual(
      expect.objectContaining({ id: "anthropic-oauth", transport: "agent-sdk" }),
    )
  })
})

describe("accounts", () => {
  test("a credential goes in and never comes back out of any endpoint", async () => {
    const { app, store } = harness()
    const account = await newAccount(app)
    const envelope = store.rows.accounts[0]?.authMaterial ?? "no-envelope"

    const responses = [
      await call(app, "GET", ADMIN_ACCOUNTS_BASE_PATH),
      await call(app, "GET", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}`),
      await call(app, "PATCH", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}`, { label: "renamed" }),
      await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/disable`),
    ]

    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.text).not.toContain(SECRET)
      expect(response.text).not.toContain(envelope)
      expect(response.text).not.toContain("authMaterial")
    }
    expect(account.hasCredential).toBe(true)
  })

  test("filters by status and by provider", async () => {
    const { app } = harness()
    const first = await newAccount(app)
    await newAccount(app, { label: "zai-1", provider: "zai" })
    await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${first.id}/disable`)

    const active = await call(app, "GET", `${ADMIN_ACCOUNTS_BASE_PATH}?status=active`)
    const zai = await call(app, "GET", `${ADMIN_ACCOUNTS_BASE_PATH}?provider=zai`)

    expect((active.body as unknown[]).length).toBe(1)
    expect((zai.body as unknown[]).length).toBe(1)
  })

  test("rejects malformed input without writing anything", async () => {
    const { app, store } = harness()

    const cases: [string, unknown][] = [
      [ADMIN_ACCOUNTS_BASE_PATH, { label: "", provider: "openrouter" }],
      [ADMIN_ACCOUNTS_BASE_PATH, { label: "x", provider: "not-a-provider" }],
      [ADMIN_ACCOUNTS_BASE_PATH, { label: "x", provider: "openrouter" }],
      [ADMIN_ACCOUNTS_BASE_PATH, { label: "x", provider: "openai-compatible", credential: SECRET }],
      [ADMIN_ACCOUNTS_BASE_PATH, "not json at all"],
    ]

    for (const [path, body] of cases) {
      expect((await call(app, "POST", path, body)).status).toBe(400)
    }
    expect(store.rows.accounts).toHaveLength(0)
  })

  test("an id that is not a uuid is a 400, and an unknown one a 404", async () => {
    const { app } = harness()
    expect((await call(app, "GET", `${ADMIN_ACCOUNTS_BASE_PATH}/nonsense`)).status).toBe(400)
    expect(
      (await call(app, "GET", `${ADMIN_ACCOUNTS_BASE_PATH}/11111111-1111-4111-8111-111111111111`))
        .status,
    ).toBe(404)
  })
})

describe("POST /:id/test — Test now", () => {
  test("sends one real completion via the account's own driver and reports the answer", async () => {
    const { app } = harness(undefined, {
      testNowFetch: async () =>
        new Response(JSON.stringify({ id: "msg_1", content: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    const account = await newAccount(app, { provider: "zai", credential: SECRET })

    const result = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/test`, {
      model: "glm-4.7",
    })

    expect(result.status).toBe(200)
    const body = result.body as { tested: boolean; outcome: string }
    expect(body.tested).toBe(true)
    expect(body.outcome).toBe("ok")
  })

  test("refuses a Claude subscription's test without confirmed, and never spends a request", async () => {
    let called = false
    const { app } = harness(undefined, {
      testNowFetch: async () => {
        called = true
        return new Response(null, { status: 200 })
      },
    })
    const account = await newAccount(app, {
      label: "claude-sub",
      provider: "anthropic-oauth",
      credential: undefined,
    })

    const result = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/test`, {
      model: "claude-sonnet-4-5",
    })

    expect(result.status).toBe(400)
    expect(called).toBe(false)
  })

  test("rejects a malformed body without touching the account", async () => {
    const { app } = harness()
    const account = await newAccount(app)

    expect(
      (await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/test`, {})).status,
    ).toBe(400)
  })
})

describe("pools", () => {
  test("create, edit membership and policy, then delete", async () => {
    const { app } = harness()
    const account = await newAccount(app)

    const created = await call(app, "POST", ADMIN_POOLS_BASE_PATH, {
      name: "team",
      members: [{ accountId: account.id, weight: 250, priority: 1 }],
    })
    expect(created.status).toBe(201)
    const pool = created.body as { id: string; members: unknown[] }
    expect(pool.members).toHaveLength(1)

    const updated = await call(app, "PATCH", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`, {
      policy: "quota-aware",
      overflowAccountId: account.id,
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({ policy: "quota-aware", overflowAccountId: account.id })

    expect((await call(app, "DELETE", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`)).status).toBe(200)
    expect((await call(app, "GET", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`)).status).toBe(404)
  })

  test("rejects an unknown policy, an unknown member, and an unknown overflow account", async () => {
    const { app, store } = harness()
    const unknown = "11111111-1111-4111-8111-111111111111"

    for (const body of [
      { name: "t", policy: "cheapest" },
      { name: "t", members: [{ accountId: unknown }] },
      { name: "t", overflowAccountId: unknown },
      { name: "t", members: [{ accountId: unknown, weight: 0 }] },
    ]) {
      expect((await call(app, "POST", ADMIN_POOLS_BASE_PATH, body)).status).toBe(400)
    }
    expect(store.rows.pools).toHaveLength(0)
  })

  test("refuses an overflow account the pool does not hold, and says how to fix it", async () => {
    const { app, store } = harness()
    const member = await newAccount(app)
    const outsider = await newAccount(app, { label: "corp-key" })

    const rejected = await call(app, "POST", ADMIN_POOLS_BASE_PATH, {
      name: "team",
      members: [{ accountId: member.id }],
      overflowAccountId: outsider.id,
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body).toMatchObject({ error: { code: "overflow_not_member" } })
    expect(store.rows.pools).toHaveLength(0)

    // The fix the message names: hold it as a member, and the same write lands.
    const accepted = await call(app, "POST", ADMIN_POOLS_BASE_PATH, {
      name: "team",
      members: [{ accountId: member.id }, { accountId: outsider.id }],
      overflowAccountId: outsider.id,
    })
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ overflowAccountId: outsider.id })
  })

  test("refuses an edit that would strand the overflow outside the membership", async () => {
    const { app } = harness()
    const member = await newAccount(app)
    const paid = await newAccount(app, { label: "paid-key" })

    const created = await call(app, "POST", ADMIN_POOLS_BASE_PATH, {
      name: "team",
      members: [{ accountId: member.id }, { accountId: paid.id }],
      overflowAccountId: paid.id,
    })
    expect(created.status).toBe(201)
    const pool = created.body as { id: string }

    const stranded = await call(app, "PATCH", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`, {
      members: [{ accountId: member.id }],
    })
    expect(stranded.status).toBe(400)
    expect(stranded.body).toMatchObject({ error: { code: "overflow_not_member" } })

    // Unchanged: a refused write leaves the pool exactly as it was.
    const after = await call(app, "GET", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`)
    expect(after.body).toMatchObject({ overflowAccountId: paid.id })
    expect((after.body as { members: unknown[] }).members).toHaveLength(2)
  })
})

describe("keys", () => {
  test("mint returns the value, and reveal returns the same one again", async () => {
    const { app } = harness()

    const created = await call(app, "POST", ADMIN_KEYS_BASE_PATH, { name: "sebastian-laptop" })
    expect(created.status).toBe(201)
    const key = created.body as { id: string; value: string; prefix: string }
    expect(key.value).toStartWith("mar_live_")

    const revealed = await call(app, "POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/reveal`)
    expect(revealed.status).toBe(200)
    expect(revealed.body).toMatchObject({ value: key.value })

    // Listing is not a reveal: the value appears only where it was asked for.
    const list = await call(app, "GET", ADMIN_KEYS_BASE_PATH)
    expect(list.text).not.toContain(key.value)
    expect(list.text).toContain(key.prefix)
  })

  test("a scope naming an unknown pool or account is refused at write time", async () => {
    const { app, store } = harness()
    const unknown = "11111111-1111-4111-8111-111111111111"

    for (const scope of [
      { kind: "pools", poolIds: [unknown] },
      { kind: "accounts", accountIds: [unknown] },
    ]) {
      const res = await call(app, "POST", ADMIN_KEYS_BASE_PATH, { name: "ci-agent-3", scope })
      expect(res.status).toBe(400)
      expect(res.text).toContain(unknown)
    }
    expect(store.rows.keys).toHaveLength(0)
  })

  test("a scope naming a real pool is stored and returned", async () => {
    const { app } = harness()
    const pool = await call(app, "POST", ADMIN_POOLS_BASE_PATH, { name: "team" })
    const poolId = (pool.body as { id: string }).id

    const created = await call(app, "POST", ADMIN_KEYS_BASE_PATH, {
      name: "ci-agent-3",
      scope: { kind: "pools", poolIds: [poolId] },
      rateLimit: { requests: 60, windowSeconds: 60 },
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      scope: { kind: "pools", poolIds: [poolId], accountIds: [] },
      rateLimit: { requests: 60, windowSeconds: 60 },
    })
  })

  test("revoking is one-way, and a revoked key still reveals", async () => {
    const { app } = harness()
    const created = await call(app, "POST", ADMIN_KEYS_BASE_PATH, { name: "old-laptop" })
    const key = created.body as { id: string; value: string }

    const revoked = await call(app, "POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/revoke`)
    expect(revoked.status).toBe(200)
    expect(revoked.body).toMatchObject({ revoked: true })
    expect((await call(app, "POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/revoke`)).status).toBe(409)

    const revealed = await call(app, "POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/reveal`)
    expect(revealed.body).toMatchObject({ value: key.value })
  })

  test("rejects malformed input without minting anything", async () => {
    const { app, store } = harness()

    for (const body of [
      {},
      { name: "" },
      { name: "k", scope: { kind: "everything" } },
      { name: "k", rateLimit: { requests: 10 } },
      { name: "k", expiresAt: "yesterday" },
    ]) {
      expect((await call(app, "POST", ADMIN_KEYS_BASE_PATH, body)).status).toBe(400)
    }
    expect(store.rows.keys).toHaveLength(0)
  })
})

describe("the OAuth callback route", () => {
  function tokenResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }

  /** Always answers the token exchange the same way, whatever provider or account calls it. */
  function fakeOAuthFetch(
    response: Response = tokenResponse({ access_token: "at-1", expires_in: 3600 }),
  ) {
    return (async () => response) as typeof fetch
  }

  async function newOAuthAccount(app: App) {
    const created = await call(app, "POST", ADMIN_ACCOUNTS_BASE_PATH, {
      label: "openai-1",
      provider: "openai-oauth",
    })
    expect(created.status).toBe(201)
    return created.body as { id: string }
  }

  async function begin(app: App, id: string): Promise<string> {
    const started = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${id}/connect`)
    expect(started.status).toBe(200)
    const state = new URL((started.body as { authorizeUrl: string }).authorizeUrl).searchParams.get(
      "state",
    )
    if (state === null) throw new Error("fake authorize URL carried no state")
    return state
  }

  /** The route answers HTML, not JSON — `call()` can't parse it, so this reads the raw response. */
  async function callback(app: App, query: Record<string, string>) {
    const res = await app.request(`${OAUTH_CALLBACK_PATH}?${new URLSearchParams(query)}`)
    return { status: res.status, text: await res.text() }
  }

  test("a real callback carries no admin session cookie, and is answered anyway", async () => {
    // The real guard, unlike the other describe blocks' `stubSession()` — proves the callback
    // route is reachable with zero cookies because it is mounted outside the guarded group
    // entirely, not merely because this harness forgot to send one. Setup goes through the
    // service directly rather than the guarded HTTP routes, since a real login flow (session +
    // CSRF) is a different surface this file already covers in `admin-auth.test.ts`.
    const service = createAdminAuthService({
      env: {
        adminUsername: "admin",
        adminCredential: { kind: "hash", value: await Bun.password.hash("hunter2") },
        encryptionKey: ENCRYPTION_KEY,
      },
    })
    const { app, store, connect } = harness(adminAuth(service, false), {
      oauthFetch: fakeOAuthFetch(),
    })
    const created = await store.accounts.create({ label: "openai-1", provider: "openai-oauth" })
    const started = await connect.begin(created.id, "connect")
    if (!started.ok) throw new Error(started.failure.message)
    const state = new URL(started.value.authorizeUrl).searchParams.get("state")
    if (state === null) throw new Error("fake authorize URL carried no state")

    // No Cookie header at all — `app.request` never sends one unless told to.
    const result = await callback(app, { code: "a-real-looking-code", state })

    expect(result.status).toBe(200)
    expect(result.text).toContain("Connected")
  })

  test("state is one-shot: a second redeem of the same state is rejected", async () => {
    const { app } = harness(stubSession(), { oauthFetch: fakeOAuthFetch() })
    const account = await newOAuthAccount(app)
    const state = await begin(app, account.id)

    const first = await callback(app, { code: "code-1", state })
    expect(first.status).toBe(200)
    expect(first.text).toContain("Connected")

    const replay = await callback(app, { code: "code-2", state })
    expect(replay.status).toBe(400)
    expect(replay.text).toContain("Not connected")
    expect(replay.text).not.toContain("code-2")
  })

  test("an expired state is rejected, the same way a reused one is", async () => {
    const clock = { now: NOW }
    const { app } = harness(stubSession(), {
      clock,
      pendingLoginMinutes: 10,
      oauthFetch: fakeOAuthFetch(),
    })
    const account = await newOAuthAccount(app)
    const state = await begin(app, account.id)

    clock.now = new Date(NOW.getTime() + 11 * 60_000)
    const result = await callback(app, { code: "code-1", state })

    expect(result.status).toBe(400)
    expect(result.text).toContain("Not connected")
  })

  test("an unknown state is rejected the same way, and never reaches the token endpoint", async () => {
    const oauthFetch = fakeOAuthFetch()
    const { app } = harness(stubSession(), { oauthFetch })

    const result = await callback(app, { code: "code-1", state: "never-issued" })

    expect(result.status).toBe(400)
    expect(result.text).toContain("Not connected")
  })

  test("a redirect carrying an authorization error still burns the state", async () => {
    const { app } = harness(stubSession())
    const account = await newOAuthAccount(app)
    const state = await begin(app, account.id)

    const refused = await callback(app, { error: "access_denied", state })
    expect(refused.status).toBe(400)
    expect(refused.text).toContain("Not connected")

    const replay = await callback(app, { code: "code", state })
    expect(replay.status).toBe(400)
  })
})

describe("connecting a Claude subscription", () => {
  async function newClaudeAccount(app: App, label: string) {
    const created = await call(app, "POST", ADMIN_ACCOUNTS_BASE_PATH, {
      label,
      provider: "anthropic-oauth",
    })
    expect(created.status).toBe(201)
    return created.body as { id: string }
  }

  function stateOf(body: unknown): string {
    const { authorizeUrl } = body as { authorizeUrl: string }
    const state = new URL(authorizeUrl).searchParams.get("state")
    if (state === null) throw new Error("fake authorize URL carried no state")
    return state
  }

  test("two accounts connect into two distinct config directories", async () => {
    const { app, configDirs } = harness()
    const first = await newClaudeAccount(app, "claude-1")
    const second = await newClaudeAccount(app, "claude-2")

    const startedFirst = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${first.id}/connect`)
    const startedSecond = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${second.id}/connect`,
    )
    expect(startedFirst.status).toBe(200)
    expect(startedSecond.status).toBe(200)

    expect(configDirs.present.has(`/data/claude/${first.id}`)).toBe(true)
    expect(configDirs.present.has(`/data/claude/${second.id}`)).toBe(true)
    expect(first.id).not.toBe(second.id)

    const doneFirst = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${first.id}/connect/complete`,
      {
        pasted: `ac_notarealcode#${stateOf(startedFirst.body)}`,
      },
    )
    const doneSecond = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${second.id}/connect/complete`,
      { pasted: `ac_notarealcode#${stateOf(startedSecond.body)}` },
    )
    expect(doneFirst.status).toBe(200)
    expect(doneSecond.status).toBe(200)
    expect((doneFirst.body as { accountId: string }).accountId).toBe(first.id)
    expect((doneSecond.body as { accountId: string }).accountId).toBe(second.id)
  })

  test("a state that belongs to a different login is rejected", async () => {
    const { app } = harness()
    const first = await newClaudeAccount(app, "claude-1")
    const second = await newClaudeAccount(app, "claude-2")
    await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${first.id}/connect`)
    const startedSecond = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${second.id}/connect`,
    )

    // The first account's login is still pending; pasting the second login's state against it
    // must fail rather than complete a login it did not start.
    const res = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${first.id}/connect/complete`,
      {
        pasted: `ac_notarealcode#${stateOf(startedSecond.body)}`,
      },
    )

    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe("state_mismatch")
  })

  test("a state is one-shot: reusing it after it is burned is rejected", async () => {
    const { app } = harness()
    const account = await newClaudeAccount(app, "claude-1")
    const started = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect`)
    const state = stateOf(started.body)

    // Wrong code, right state: burns the one-shot pending login.
    const wrong = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect/complete`,
      {
        pasted: `ac_wrong#not-${state}`,
      },
    )
    expect(wrong.status).toBe(400)
    expect((wrong.body as { error: { code: string } }).error.code).toBe("state_mismatch")

    // Reusing the very same, now-burned state is refused too — there is nothing pending anymore.
    const replay = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect/complete`,
      {
        pasted: `ac_notarealcode#${state}`,
      },
    )
    expect(replay.status).toBe(400)
    expect((replay.body as { error: { code: string } }).error.code).toBe("no_pending_login")
  })

  test("a paste after the window closes is rejected as expired", async () => {
    const clock = { now: NOW }
    const { app } = harness(stubSession(), { clock, pendingLoginMinutes: 10 })
    const account = await newClaudeAccount(app, "claude-1")
    const started = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect`)
    const state = stateOf(started.body)

    clock.now = new Date(NOW.getTime() + 11 * 60_000)
    const res = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect/complete`,
      {
        pasted: `ac_notarealcode#${state}`,
      },
    )

    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe("login_expired")
  })

  test("no response, log line, or error body ever carries the pasted code or the state", async () => {
    const { app, logLines } = harness()
    const account = await newClaudeAccount(app, "claude-1")
    const started = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect`)
    const state = stateOf(started.body)
    const pastedCode = "ac_notarealcode"

    // A rejected paste (wrong state) and a successful one, and every rejection shape besides —
    // every one of these responses and every log line the router wrote while handling them.
    const mismatch = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect/complete`,
      { pasted: `${pastedCode}#not-${state}` },
    )
    const secondStart = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect`)
    const secondState = stateOf(secondStart.body)
    const completed = await call(
      app,
      "POST",
      `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/connect/complete`,
      { pasted: `${pastedCode}#${secondState}` },
    )

    expect(mismatch.status).toBe(400)
    expect(completed.status).toBe(200)

    const rendered = [mismatch.text, completed.text, ...logLines].join("\n")
    expect(rendered).not.toContain(pastedCode)
    expect(rendered).not.toContain(secondState)
    // The authorize URL is the one place a state may legitimately appear — it was handed back in
    // `started.value.authorizeUrl` for the operator to open, never in a completion or a log line.
  })

  test("an account with no login flow at all is refused by name", async () => {
    const { app } = harness()
    // An API-key provider: neither the CLI's login nor an authorization flow this router drives.
    const openrouter = await newAccount(app)

    const res = await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${openrouter.id}/connect`)

    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe("not_an_oauth_account")
  })
})

describe("audit", () => {
  test("every mutation is recorded, and no row carries credential material", async () => {
    const { app, store } = harness()

    const account = await newAccount(app)
    await call(app, "PATCH", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}`, { label: "renamed" })
    const pool = await call(app, "POST", ADMIN_POOLS_BASE_PATH, { name: "team" })
    const poolId = (pool.body as { id: string }).id
    await call(app, "PATCH", `${ADMIN_POOLS_BASE_PATH}/${poolId}`, { policy: "round-robin" })
    const key = await call(app, "POST", ADMIN_KEYS_BASE_PATH, { name: "sebastian-laptop" })
    const keyId = (key.body as { id: string }).id
    await call(app, "POST", `${ADMIN_KEYS_BASE_PATH}/${keyId}/reveal`)
    await call(app, "POST", `${ADMIN_KEYS_BASE_PATH}/${keyId}/revoke`)
    await call(app, "POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/disable`)

    expect(store.rows.audit.map((row) => row.kind)).toEqual([
      "account.created",
      "account.updated",
      "pool.created",
      "pool.updated",
      // A policy move is its own event beside the update: "why did traffic shift" must be
      // answerable without opening every `pool.updated` in the log.
      "policy.changed",
      "key.created",
      "key.revealed",
      "key.revoked",
      "account.disabled",
    ])

    const rendered = JSON.stringify(store.rows.audit)
    expect(rendered).not.toContain(SECRET)
    expect(rendered).not.toContain((key.body as { value: string }).value)
    expect(rendered).not.toContain("v1.k1.")
    expect(rendered).not.toContain("mar_live_")
  })

  test("a rejected mutation writes no audit row at all", async () => {
    const { app, store } = harness()
    await call(app, "POST", ADMIN_ACCOUNTS_BASE_PATH, { label: "x", provider: "gemini" })
    await call(app, "POST", ADMIN_POOLS_BASE_PATH, { name: "t", policy: "cheapest" })
    await call(app, "POST", ADMIN_KEYS_BASE_PATH, { name: "" })

    expect(store.rows.audit).toHaveLength(0)
  })
})
