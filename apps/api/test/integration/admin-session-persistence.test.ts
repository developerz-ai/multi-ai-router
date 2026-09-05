import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type AdminSessionRepository,
  createAdminSessionRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createLogger } from "../../src/logging/logger"
import {
  createPostgresSessionStore,
  hashSessionId,
} from "../../src/services/admin-auth/postgresSessionStore"
import {
  type AdminAuthService,
  createAdminAuthService,
} from "../../src/services/admin-auth/service"
import type { SessionStore } from "../../src/services/admin-auth/sessionStore"

/**
 * The property the Postgres session store exists for: a cookie minted by one
 * router process authenticates against another. Two store instances over one
 * database stand in for "before and after a restart" — the second has an empty
 * cache and never saw the login, so everything it knows it read from the row.
 *
 * Skips when `DATABASE_URL` is unset, like every other live-database test in
 * this app. Every row it writes is deleted by its own hash on the way out.
 */
const databaseUrl = process.env.DATABASE_URL
const runnable = databaseUrl !== undefined && databaseUrl !== ""

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const PASSWORD = "correct horse battery staple"
const IP = "203.0.113.7"

let handle: DatabaseHandle | undefined
let repository: AdminSessionRepository
const issuedIds: string[] = []

/** A fresh process's worth of admin auth: its own store and cache over the shared table. */
function replica(now: () => number): { store: SessionStore; auth: AdminAuthService } {
  const store = createPostgresSessionStore({
    repository,
    logger: createLogger({ level: "error", write: () => undefined }),
    cacheMaxEntries: 16,
  })
  const auth = createAdminAuthService({
    env: { adminOidc: null, encryptionKey: ENCRYPTION_KEY },
    local: {
      isConfigured: async () => true,
      verify: async (password) => password === PASSWORD,
    },
    store,
    now,
  })
  return { store, auth }
}

beforeAll(async () => {
  if (!runnable) return
  const url = databaseUrl ?? ""
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  repository = createAdminSessionRepository(handle.db)
})

afterAll(async () => {
  if (handle !== undefined) {
    for (const id of issuedIds) await repository.delete(hashSessionId(id))
  }
  await handle?.close()
})

describe.skipIf(!runnable)("admin sessions survive a restart", () => {
  test("a cookie from one replica authenticates on a fresh one, logout invalidates it everywhere", async () => {
    const start = Date.now()
    const first = replica(() => start)
    const login = await first.auth.completeLocalLogin({ password: PASSWORD, ip: IP })
    issuedIds.push(login.session.id)

    // "After the restart": nothing cached, the row is all there is.
    const second = replica(() => start + 1_000)
    const resumed = await second.auth.authenticate(login.cookieValue)
    expect(resumed.username).toBe(login.session.username)
    expect(resumed.csrfToken).toBe(login.session.csrfToken)
    expect(resumed.createdAtMs).toBe(login.session.createdAtMs)
    expect(resumed.absoluteExpiryMs).toBe(login.session.absoluteExpiryMs)

    await second.auth.logout(login.session.id, IP, resumed.username)

    // A third instance, so the assertion is about the table and not about the
    // second instance's own cache eviction.
    const third = replica(() => start + 2_000)
    await expect(third.auth.authenticate(login.cookieValue)).rejects.toThrow()
  })

  test("the purge with a far-future clock removes the row", async () => {
    const start = Date.now()
    const first = replica(() => start)
    const login = await first.auth.completeLocalLogin({ password: PASSWORD, ip: IP })
    issuedIds.push(login.session.id)

    const sweeper = replica(() => start)
    const farFuture = login.session.absoluteExpiryMs + 1
    expect(await sweeper.store.deleteExpired(farFuture, 1_000)).toBeGreaterThanOrEqual(1)

    const after = replica(() => start + 1_000)
    await expect(after.auth.authenticate(login.cookieValue)).rejects.toThrow()
  })
})
