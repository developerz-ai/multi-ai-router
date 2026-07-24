import { describe, expect, test } from "bun:test"
import { AdminAuthError, CsrfTokenError, QuotaExhaustedError } from "@multi-ai-router/core"
import type { AdminAuthConfig } from "../../../src/services/admin-auth/config"
import { ARGON2ID_PARAMS } from "../../../src/services/admin-auth/password"
import { createAdminAuthService } from "../../../src/services/admin-auth/service"
import { createMemorySessionStore } from "../../../src/services/admin-auth/sessionStore"
import {
  deriveSessionSigningKey,
  parseSignedSessionId,
} from "../../../src/services/admin-auth/sessionToken"

/**
 * The service holds every rule the routes and the guard delegate to. Clock injected, store
 * injected, argon2id real — the hash is the one thing worth not faking, because the timing
 * guarantee below is a property of actually running it.
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const PASSWORD = "hunter2"
const PASSWORD_HASH = await Bun.password.hash(PASSWORD, ARGON2ID_PARAMS)
const IP = "203.0.113.7"

const HOUR_MS = 60 * 60 * 1000

function build(config: Partial<AdminAuthConfig> = {}) {
  const clock = { nowMs: 1_700_000_000_000 }
  const store = createMemorySessionStore()
  const service = createAdminAuthService({
    env: {
      adminUsername: "admin",
      adminCredential: { kind: "hash", value: PASSWORD_HASH },
      encryptionKey: ENCRYPTION_KEY,
    },
    store,
    config,
    now: () => clock.nowMs,
  })
  return { clock, store, service }
}

function login(service: ReturnType<typeof build>["service"], password = PASSWORD) {
  return service.login({ username: "admin", password, ip: IP })
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the call to reject")
}

describe("login", () => {
  test("the right credentials mint a session with a signed cookie and a CSRF token", async () => {
    const { service, store } = build()
    const result = await login(service)

    expect(result.session.username).toBe("admin")
    expect(result.session.csrfToken.length).toBeGreaterThan(20)
    expect(result.cookieMaxAgeSeconds).toBe(service.config.idleTtlSeconds)
    expect(await store.get(result.session.id)).toBeDefined()

    const signed = parseSignedSessionId(result.cookieValue, deriveSessionSigningKey(ENCRYPTION_KEY))
    expect(signed).toBe(result.session.id)
    // The cookie carries an opaque id — never the username, never anything derived from it.
    expect(result.cookieValue).not.toContain("admin")
  })

  test("sets both bounds: the sliding idle window and the absolute cap", async () => {
    const { service, clock } = build({ idleTtlSeconds: 3600, absoluteTtlSeconds: 86_400 })
    const { session } = await login(service)

    expect(session.idleExpiryMs).toBe(clock.nowMs + 3_600_000)
    expect(session.absoluteExpiryMs).toBe(clock.nowMs + 86_400_000)
  })

  test("a wrong password and an unknown username are the same failure, word for word", async () => {
    const { service } = build()

    const wrongPassword = await rejection(login(service, "wrong"))
    const unknownUser = await rejection(
      service.login({ username: "root", password: PASSWORD, ip: IP }),
    )

    expect(wrongPassword).toBeInstanceOf(AdminAuthError)
    expect(unknownUser).toBeInstanceOf(AdminAuthError)
    expect(unknownUser.message).toBe(wrongPassword.message)
    expect(wrongPassword.message).toBe("Invalid username or password")
    // Nothing in the failure hints at which half was wrong.
    expect(wrongPassword.message).not.toContain("admin")
  })

  test("an unknown username costs the same argon2id verification as a wrong password", async () => {
    // The throttle would otherwise lock us out mid-measurement.
    const { service } = build({ maxFailedAttempts: 1_000 })
    const samples = 5

    const wrongPassword = await medianMs(samples, () => rejection(login(service, "wrong")))
    const unknownUser = await medianMs(samples, () =>
      rejection(service.login({ username: "nobody", password: PASSWORD, ip: IP })),
    )

    // A short-circuit on the username would make this path effectively free; argon2id at the
    // pinned parameters is milliseconds. The floor is what proves the hash ran on both paths.
    expect(unknownUser).toBeGreaterThan(5)
    expect(wrongPassword).toBeGreaterThan(5)

    const slower = Math.max(wrongPassword, unknownUser)
    const faster = Math.min(wrongPassword, unknownUser)
    expect(slower - faster).toBeLessThan(faster)
  })

  test("locks out after the configured attempts and answers 429 with a Retry-After", async () => {
    const { service } = build({ maxFailedAttempts: 3, lockoutSeconds: 900 })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await rejection(login(service, "wrong"))
    }

    const locked = await rejection(login(service))
    expect(locked).toBeInstanceOf(QuotaExhaustedError)
    expect((locked as QuotaExhaustedError).status).toBe(429)
    expect((locked as QuotaExhaustedError).retryAfterSeconds).toBe(900)
    expect(locked.message).not.toContain("password")
  })

  test("the lockout is on the credentials, not the password — the right one is refused too", async () => {
    const { service } = build({ maxFailedAttempts: 2 })
    await rejection(login(service, "wrong"))
    await rejection(login(service, "wrong"))

    expect(await rejection(login(service))).toBeInstanceOf(QuotaExhaustedError)
  })

  test("releases once the lockout window passes", async () => {
    const { service, clock } = build({ maxFailedAttempts: 2, lockoutSeconds: 900 })
    await rejection(login(service, "wrong"))
    await rejection(login(service, "wrong"))

    clock.nowMs += 900 * 1000
    const result = await login(service)
    expect(result.session.username).toBe("admin")
  })

  test("a success clears the counter, so a typo does not accumulate across days", async () => {
    const { service } = build({ maxFailedAttempts: 3 })
    await rejection(login(service, "wrong"))
    await rejection(login(service, "wrong"))
    await login(service)

    await rejection(login(service, "wrong"))
    await rejection(login(service, "wrong"))
    // Would be attempt 4 if the earlier failures still counted.
    expect(await rejection(login(service, "wrong"))).toBeInstanceOf(AdminAuthError)
  })
})

describe("authenticate", () => {
  test("a valid cookie resolves the session", async () => {
    const { service } = build()
    const { session, cookieValue } = await login(service)

    expect((await service.authenticate(cookieValue)).id).toBe(session.id)
  })

  test("no cookie, an empty one, garbage, or a forged signature are all 401", async () => {
    const { service } = build()
    const { cookieValue } = await login(service)
    const [id, signature] = cookieValue.split(".")

    for (const value of [undefined, "", "garbage", id, `${id}.${signature}x`, `x.${signature}`]) {
      const error = await rejection(service.authenticate(value))
      expect(error).toBeInstanceOf(AdminAuthError)
      expect((error as AdminAuthError).status).toBe(401)
    }
  })

  test("a session that outlived its idle window is refused and deleted", async () => {
    const { service, store, clock } = build({ idleTtlSeconds: 3600 })
    const { session, cookieValue } = await login(service)

    clock.nowMs += 3_600_000
    expect((await rejection(service.authenticate(cookieValue))).message).toBe(
      "Admin session has expired",
    )
    expect(await store.get(session.id)).toBeUndefined()
  })

  test("activity slides the idle window forward", async () => {
    const { service, clock } = build({ idleTtlSeconds: 3600 })
    const { cookieValue } = await login(service)

    for (let hop = 0; hop < 5; hop += 1) {
      clock.nowMs += 30 * 60 * 1000
      const session = await service.authenticate(cookieValue)
      expect(session.idleExpiryMs).toBe(clock.nowMs + 3_600_000)
      expect(session.lastSeenAtMs).toBe(clock.nowMs)
    }
  })

  test("the absolute cap ends the session no matter how active it was", async () => {
    const { service, clock } = build({ idleTtlSeconds: 3600, absoluteTtlSeconds: 4 * 3600 })
    const { cookieValue } = await login(service)

    for (let hop = 0; hop < 7; hop += 1) {
      clock.nowMs += HOUR_MS / 2
      await service.authenticate(cookieValue)
    }

    clock.nowMs += HOUR_MS / 2
    expect((await rejection(service.authenticate(cookieValue))).message).toBe(
      "Admin session has expired",
    )
  })

  test("a session id from another deployment's signing key never validates", async () => {
    const { service } = build()
    const { cookieValue } = await login(service)
    const other = createAdminAuthService({
      env: {
        adminUsername: "admin",
        adminCredential: { kind: "hash", value: PASSWORD_HASH },
        encryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
    })

    expect(await rejection(other.authenticate(cookieValue))).toBeInstanceOf(AdminAuthError)
  })
})

describe("logout", () => {
  test("invalidates server-side — the same cookie stops working", async () => {
    const { service, store } = build()
    const { session, cookieValue } = await login(service)

    await service.logout(session.id)

    expect(await store.get(session.id)).toBeUndefined()
    expect(await rejection(service.authenticate(cookieValue))).toBeInstanceOf(AdminAuthError)
  })
})

describe("assertCsrf", () => {
  test("accepts the session's own token and nothing else", async () => {
    const { service } = build()
    const { session } = await login(service)
    const other = (await login(service)).session

    expect(() => service.assertCsrf(session, session.csrfToken)).not.toThrow()
    expect(() => service.assertCsrf(session, other.csrfToken)).toThrow(CsrfTokenError)
    expect(() => service.assertCsrf(session, undefined)).toThrow(CsrfTokenError)
    expect(() => service.assertCsrf(session, "")).toThrow(CsrfTokenError)
  })
})

async function medianMs(samples: number, run: () => Promise<unknown>): Promise<number> {
  const times: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now()
    await run()
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)] ?? 0
}
