import { describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "../../src/routes/admin/accounts"
import { ADMIN_KEYS_BASE_PATH, adminKeyRoutes } from "../../src/routes/admin/keys"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "../../src/routes/admin/pools"
import { ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes } from "../../src/routes/admin/providers"
import { createAccountsService } from "../../src/services/accounts"
import { createAuditRecorder } from "../../src/services/admin"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
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

function harness(guard: MiddlewareHandler<AdminAuthEnv> = stubSession()) {
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const audit = createAuditRecorder(store.audit)
  const now = () => NOW

  const app = new Hono<AdminAuthEnv>()
  const logger = createLogger({ level: "error", write: () => undefined })
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())

  app.route(
    ADMIN_ACCOUNTS_BASE_PATH,
    adminAccountRoutes({
      guard,
      service: createAccountsService({
        accounts: store.accounts,
        keys: store.keys,
        cipher,
        configDirs: createMemoryConfigDirs().dirs,
        audit,
        now,
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

  return { app, store }
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
    const { app } = harness(adminAuth(service))

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
