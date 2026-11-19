import { describe, expect, test } from "bun:test"
import type { AdminCredentialRepository } from "@multi-ai-router/db"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthGuardService } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { REQUEST_ID_HEADER, requestId } from "../../src/middleware/requestId"
import { ADMIN_AUTH_BASE_PATH, adminAuthRoutes } from "../../src/routes/admin/auth"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "../../src/routes/admin/pools"
import { createAuditRecorder } from "../../src/services/admin"
import {
  ADMIN_API_TOKEN_ACTOR,
  CSRF_HEADER,
  LOCAL_ADMIN_USERNAME,
} from "../../src/services/admin-auth"
import { createLocalAdminCredentials } from "../../src/services/admin-auth/localCredential"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import { createMemorySessionStore } from "../../src/services/admin-auth/sessionStore"
import { createPoolsService } from "../../src/services/pools"
import type { AppEnv } from "../../src/types"
import { createMemoryStore } from "../support/memory-store"
import { silentLogger } from "../support/silent-logger"

/**
 * multi-ai-router#453: an admin request names its caller on the audit row it causes. Driven through
 * the real guard and a real route group, because the guard is where the caller is captured and a
 * test that hand-sets the context would prove only the recorder.
 */

const TOKEN = "t".repeat(48)
const OPERATOR = "ops@example.test"
const NOW = new Date("2026-11-19T12:00:00.000Z")

function guardService(): AdminAuthGuardService {
  return {
    authenticate: async () => ({
      id: "session-1",
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

function harness(trustedHops = 0) {
  const store = createMemoryStore()
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(silentLogger()))
  app.onError(errorHandler(silentLogger(), null))
  app.route(
    ADMIN_POOLS_BASE_PATH,
    adminPoolRoutes({
      guard: adminAuth(guardService(), false, TOKEN, trustedHops),
      service: createPoolsService({
        logger: silentLogger(),
        mutations: store.mutations,
        onCommitted: () => {},
        pools: store.pools,
        accounts: store.accounts,
        now: () => NOW,
      }),
    }),
  )
  return { app, store }
}

async function createPool(
  app: ReturnType<typeof harness>["app"],
  headers: Record<string, string>,
): Promise<Response> {
  const response = await app.request(ADMIN_POOLS_BASE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "csrf", ...headers },
    body: JSON.stringify({ name: `pool-${crypto.randomUUID()}` }),
  })
  expect(response.status).toBe(201)
  return response
}

function onlyRow(store: ReturnType<typeof harness>["store"]) {
  expect(store.rows.audit).toHaveLength(1)
  const row = store.rows.audit[0]
  if (row === undefined) throw new Error("no audit row")
  return row
}

describe("an admin request stamps its caller on the audit row", () => {
  test("a session caller is recorded by its email, as a session", async () => {
    const { app, store } = harness()
    const response = await createPool(app, { "user-agent": "console/1.0" })

    const row = onlyRow(store)
    expect(row.kind).toBe("pool.created")
    expect(row.actor).toBe(OPERATOR)
    expect(row.actorKind).toBe("session")
    expect(row.actorSays).toBeNull()
    expect(row.userAgent).toBe("console/1.0")
    expect(row.requestId).toBe(response.headers.get(REQUEST_ID_HEADER))
    expect(row.requestId).not.toBeNull()
  })

  test("the admin token is recorded as admin-api-token, with the X-Admin-Actor it declared", async () => {
    const { app, store } = harness()
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-admin-actor": "  agent ops-seat-slice02 for sebyx07  ",
    })

    const row = onlyRow(store)
    expect(row.actor).toBe(ADMIN_API_TOKEN_ACTOR)
    expect(row.actorKind).toBe("api_token")
    expect(row.actorSays).toBe("agent ops-seat-slice02 for sebyx07")
  })

  test("a token call with no X-Admin-Actor is let in and records no declared name", async () => {
    const { app, store } = harness()
    await createPool(app, { authorization: `Bearer ${TOKEN}` })

    const row = onlyRow(store)
    expect(row.actorKind).toBe("api_token")
    expect(row.actorSays).toBeNull()
  })

  test("a 300-character X-Admin-Actor and user agent are each capped at 200", async () => {
    const { app, store } = harness()
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-admin-actor": "a".repeat(300),
      "user-agent": "u".repeat(300),
    })

    const row = onlyRow(store)
    expect(row.actorSays).toBe("a".repeat(200))
    expect(row.userAgent).toBe("u".repeat(200))
  })

  test("a router key or a bearer credential in X-Admin-Actor is stored redacted", async () => {
    const routerKey = `mar_live_${"k".repeat(40)}`
    const bearer = "Bearer abcdefghijklmnop1234"
    const { app, store } = harness()
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-admin-actor": `deploy-bot ${routerKey}`,
    })
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-admin-actor": `ci ${bearer}`,
    })

    const says = store.rows.audit.map((row) => row.actorSays)
    expect(says).toEqual(["deploy-bot [REDACTED]", "ci [REDACTED]"])
    expect(JSON.stringify(says)).not.toContain("mar_live_")
    expect(JSON.stringify(says)).not.toContain("abcdefghijklmnop")
  })

  test("an auth scheme in X-Admin-Actor is redacted however short its value: Bearer x", async () => {
    const { app, store } = harness()
    await createPool(app, { authorization: `Bearer ${TOKEN}`, "x-admin-actor": "Bearer x" })
    await createPool(app, { authorization: `Bearer ${TOKEN}`, "x-admin-actor": "bot basic:abc" })

    expect(store.rows.audit.map((row) => row.actorSays)).toEqual(["[REDACTED]", "bot basic:abc"])
  })

  test("a credential straddling the 200-character cap is redacted before it is cut", async () => {
    const { app, store } = harness()
    const routerKey = `mar_live_${"k".repeat(40)}`
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-admin-actor": `${"x".repeat(180)}${routerKey}`,
    })

    const row = onlyRow(store)
    expect(row.actorSays).toBe(`${"x".repeat(180)}[REDACTED]`)
  })

  test("client_ip honours the trusted hops: a spoofed leftmost X-Forwarded-For entry is ignored", async () => {
    const { app, store } = harness(1)
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-forwarded-for": "6.6.6.6, 203.0.113.7",
    })

    expect(onlyRow(store).clientIp).toBe("203.0.113.7")
  })

  test("with TRUST_PROXY off, X-Forwarded-For is not read at all", async () => {
    const { app, store } = harness(0)
    await createPool(app, {
      authorization: `Bearer ${TOKEN}`,
      "x-forwarded-for": "6.6.6.6",
    })

    // No Bun server behind `app.request`, so no socket peer: the documented fallback.
    expect(onlyRow(store).clientIp).toBe("unknown")
  })
})

/**
 * The sign-in routes run before any credential is accepted, so there is no session to name. They
 * still record where the attempt came from, as `anonymous` — not `unattributed`, which is the
 * recorder's bug report and would fire an error line on every mistyped password.
 */
describe("a sign-in attempt", () => {
  const PASSWORD = "correct horse battery staple"

  async function signInHarness() {
    const store = createMemoryStore()
    const lines: Record<string, unknown>[] = []
    const logger = createLogger({
      level: "debug",
      write: (line) => void lines.push(JSON.parse(line)),
    })
    const local = createLocalAdminCredentials({ repository: memoryCredentialRepository() })
    await local.set(PASSWORD)
    const service = createAdminAuthService({
      env: { adminOidc: null, encryptionKey: Buffer.alloc(32, 7).toString("base64") },
      oidc: null,
      local,
      store: createMemorySessionStore(),
      audit: createAuditRecorder(store.audit, logger),
      now: () => NOW.getTime(),
    })
    const app = new Hono<AppEnv>()
    app.use("*", requestId())
    app.use("*", requestLogger(silentLogger()))
    app.onError(errorHandler(silentLogger(), null))
    app.route(
      ADMIN_AUTH_BASE_PATH,
      adminAuthRoutes({
        service,
        trustProxy: true,
        trustProxyHops: 1,
        sessionCookieInsecure: false,
      }),
    )
    return { app, store, lines }
  }

  /** The login rows are fire-and-forget; wait for the append, never for a fixed time. */
  async function rows(store: ReturnType<typeof createMemoryStore>, count: number) {
    for (let spin = 0; spin < 100 && store.rows.audit.length < count; spin++) await Bun.sleep(1)
    expect(store.rows.audit).toHaveLength(count)
    return store.rows.audit
  }

  function login(app: Hono<AppEnv>, password: string) {
    return app.request(`${ADMIN_AUTH_BASE_PATH}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "6.6.6.6, 198.51.100.4",
        "user-agent": "curl/8",
      },
      body: JSON.stringify({ password }),
    })
  }

  test("a rejected password is recorded as anonymous, from the resolved address, with no error line", async () => {
    const { app, store, lines } = await signInHarness()
    expect((await login(app, "wrong")).status).toBe(401)

    const [row] = await rows(store, 1)
    expect(row).toMatchObject({
      kind: "admin.login_failed",
      actor: "anonymous",
      actorKind: "anonymous",
      clientIp: "198.51.100.4",
      userAgent: "curl/8",
    })
    expect(lines.filter((line) => line.msg === "audit event without a caller")).toEqual([])
  })

  test("logout, behind the guard, is the session's own act", async () => {
    const { app, store } = await signInHarness()
    const signedIn = await login(app, PASSWORD)
    expect(signedIn.status).toBe(200)
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const { csrfToken } = (await signedIn.json()) as { csrfToken: string }

    const out = await app.request(`${ADMIN_AUTH_BASE_PATH}/logout`, {
      method: "POST",
      headers: { cookie, [CSRF_HEADER]: csrfToken },
    })
    expect(out.status).toBe(200)

    const [loggedIn, loggedOut] = await rows(store, 2)
    expect(loggedIn).toMatchObject({ kind: "admin.login", actorKind: "anonymous" })
    expect(loggedOut).toMatchObject({
      kind: "admin.logout",
      actor: LOCAL_ADMIN_USERNAME,
      actorKind: "session",
    })
  })
})

function memoryCredentialRepository(): AdminCredentialRepository {
  let hash: string | null = null
  const row = () =>
    hash === null ? undefined : { id: "local", passwordHash: hash, createdAt: NOW, updatedAt: NOW }
  return {
    get: async () => row(),
    upsertHash: async (input) => {
      hash = input.passwordHash
      const written = row()
      if (written === undefined) throw new Error("unreachable")
      return written
    },
    remove: async () => {
      const existed = hash !== null
      hash = null
      return existed
    },
  }
}
