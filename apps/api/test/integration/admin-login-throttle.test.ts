import { describe, expect, test } from "bun:test"
import { createAdminLoginThrottleRepository, createDatabase } from "@multi-ai-router/db"
import { sql } from "drizzle-orm"
import { ownDatabaseFixture } from "../../../../packages/db/test/integration/own-database-fixture"
import { resolveAdminAuthConfig } from "../../src/services/admin-auth/config"
import {
  AdminLoginThrottledError,
  createAdminAuthService,
} from "../../src/services/admin-auth/service"
import { createSharedThrottle } from "../../src/services/admin-auth/shared-throttle"
import { ipThrottleKey } from "../../src/services/admin-auth/throttle"

const fixture = ownDatabaseFixture("admin_throttle")
const config = resolveAdminAuthConfig({ maxFailedAttempts: 3, maxConcurrentLogins: 20 })
const env = { adminOidc: null, encryptionKey: Buffer.alloc(32, 7).toString("base64") }

describe.skipIf(!process.env.DATABASE_URL)("shared login budget", () => {
  test("capacity, denial flags, expiry, reset and namespaces are shared", async () => {
    const other = createDatabase({ url: fixture.url(), maxConnections: 2 })
    const a = createAdminLoginThrottleRepository(fixture.db())
    const b = createAdminLoginThrottleRepository(other.db)
    const policy = { ...config, maxTrackedIps: 1, maxFailedAttempts: 1, evictionIntervalMs: 0 }
    const key = ipThrottleKey("2001:db8:1:2::1")
    try {
      await fixture.db().execute(sql`delete from admin_login_throttle_buckets`)
      expect(await a.consume("local", key, policy)).toEqual({ allowed: true })
      const denials = await Promise.all(
        [a, b].map((r) => r.consume("local", ipThrottleKey("2001:db8:1:2::9"), policy)),
      )
      expect(denials.filter((r) => !r.allowed && r.firstDenial)).toHaveLength(1)
      expect(await b.consume("local", "other", policy)).toMatchObject({ allowed: false })
      expect(await b.consume("oidc-start", key, policy)).toEqual({ allowed: true })
      await b.reset("local", key)
      expect(await a.consume("local", "other", policy)).toEqual({ allowed: true })
      await fixture
        .db()
        .execute(
          sql`update admin_login_throttle_buckets set expires_at = 'epoch' where namespace = 'local'`,
        )
      expect(await b.consume("local", key, policy)).toEqual({ allowed: true })
    } finally {
      await fixture.db().execute(sql`delete from admin_login_throttle_buckets`)
      await other.close()
    }
  })

  test("storage failure is sanitized and releases the password slot", async () => {
    let verifies = 0
    let fail = true
    const throttle = createSharedThrottle(
      {
        consume: async () => {
          if (fail) throw new Error("private SQL detail")
          return { allowed: true }
        },
        reset: async () => {
          throw new Error("private SQL detail")
        },
      },
      config,
    )
    const service = createAdminAuthService({
      env,
      config: { maxConcurrentLogins: 1 },
      throttle,
      local: {
        isConfigured: async () => true,
        set: async () => {},
        remove: async () => false,
        verify: async () => {
          verifies++
          return true
        },
      },
    })
    const login = () => service.completeLocalLogin({ ip: "test", password: "test" })
    await expect(login()).rejects.toThrow("Sign-in is temporarily unavailable.")
    expect(verifies).toBe(0)
    fail = false
    await expect(login()).rejects.toThrow("Sign-in is temporarily unavailable.")
    await expect(login()).rejects.toThrow("Sign-in is temporarily unavailable.")
    expect(verifies).toBe(2)
  })

  for (const method of ["local", "oidc-start", "oidc-callback"] as const) {
    test(`${method} admits only three attempts across separate pools and a restart`, async () => {
      const other = createDatabase({ url: fixture.url(), maxConnections: 2 })
      let calls = 0
      const replica = (db: typeof other.db) =>
        createAdminAuthService({
          env,
          config,
          throttle: createSharedThrottle(createAdminLoginThrottleRepository(db), config),
          local: {
            isConfigured: async () => true,
            set: async () => {},
            remove: async () => false,
            verify: async () => {
              calls++
              return false
            },
          },
          oidc: {
            start: async () => {
              calls++
              return { authorizeUrl: "https://idp.test", state: "test" }
            },
            complete: async () => {
              calls++
              throw new Error("invalid callback")
            },
          },
        })
      const invoke = (service: ReturnType<typeof replica>) => {
        const ip = `test-${method}`
        if (method === "local") return service.completeLocalLogin({ password: "wrong", ip })
        if (method === "oidc-start") return service.startLogin(ip)
        return service.completeLogin({ code: "test", state: "test", ip })
      }
      try {
        const a = replica(fixture.db())
        const b = replica(other.db)
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            invoke(i % 2 ? a : b).catch((error: unknown) => error),
          ),
        )
        expect(calls).toBe(3)
        expect(results.filter((r) => r instanceof AdminLoginThrottledError)).toHaveLength(17)
        await expect(invoke(replica(other.db))).rejects.toBeInstanceOf(AdminLoginThrottledError)
        expect(calls).toBe(3)
      } finally {
        await other.close()
      }
    })
  }

  test("a successful OIDC callback clears both budgets across instances", async () => {
    const other = createDatabase({ url: fixture.url(), maxConnections: 2 })
    const policy = { ...config, maxFailedAttempts: 1 }
    const replica = (db: typeof other.db) =>
      createAdminAuthService({
        env,
        config: policy,
        throttle: createSharedThrottle(createAdminLoginThrottleRepository(db), policy),
        oidc: {
          start: async () => ({ authorizeUrl: "https://idp.test", state: "test" }),
          complete: async () => ({ email: "admin@test", subject: "subject-1" }),
        },
      })
    const ip = "2001:db8:1:2::1"
    try {
      await fixture.db().execute(sql`delete from admin_login_throttle_buckets`)
      const a = replica(fixture.db())
      const b = replica(other.db)

      await a.startLogin(ip)
      await b.completeLogin({ code: "test", state: "test", ip })

      // Both are independent Postgres-backed instances. Each admission below fails if the successful
      // callback did not clear the start or callback bucket that either instance will read next.
      await a.startLogin(ip)
      await b.completeLogin({ code: "test", state: "test", ip })
    } finally {
      await fixture.db().execute(sql`delete from admin_login_throttle_buckets`)
      await other.close()
    }
  })
})
