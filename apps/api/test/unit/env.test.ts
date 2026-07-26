import { describe, expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../src/config/env"

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")

/** The minimum an operator must set by hand, plus the DATABASE_URL compose supplies. */
const base: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://router:router@postgres:5432/router",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "hunter2",
  ENCRYPTION_KEY,
}

function expectEnvError(raw: Record<string, string | undefined>): EnvValidationError {
  try {
    parseEnv(raw)
  } catch (error) {
    if (error instanceof EnvValidationError) return error
    throw error
  }
  throw new Error("expected parseEnv to throw an EnvValidationError")
}

describe("parseEnv", () => {
  test("applies every documented default", () => {
    const env = parseEnv(base)

    expect(env.port).toBe(8080)
    expect(env.logLevel).toBe("info")
    expect(env.trustProxy).toBe(false)
    expect(env.publicUrl).toBeNull()
    expect(env.webRoot).toBeNull()
    expect(env.claudeConfigRoot).toBe("/data/claude")
    expect(env.accountRecheckCooldownSeconds).toBe(60)
    expect(env.accountTestNowCooldownSeconds).toBe(120)
    expect(env.janitorIntervalMinutes).toBe(60)
    expect(env.retention).toEqual({
      sessionsHours: 24,
      usageDays: 90,
      auditDays: 365,
      revokedKeysDays: 30,
      oauthStateMinutes: 10,
      orphanConfigDirHours: 24,
    })
    expect(env.scheduler).toEqual({
      usageRollupIntervalMinutes: 60,
      oauthStatePurgeIntervalMinutes: 5,
      quotaFloorIntervalMinutes: 30,
      configDirReapIntervalMinutes: 360,
      sweepBatchSize: 1_000,
      jitterFraction: 0.2,
    })
    expect(env.adminAuth).toEqual({
      sessionIdleMinutes: 480,
      sessionAbsoluteHours: 24,
      loginMaxAttempts: 5,
      loginAttemptWindowMinutes: 15,
      loginLockoutMinutes: 15,
      sessionSlideFraction: 0.1,
      sessionCookieInsecure: false,
    })
  })

  test("reads overrides for every knob", () => {
    const env = parseEnv({
      ...base,
      PORT: "9000",
      LOG_LEVEL: "debug",
      TRUST_PROXY: "true",
      PUBLIC_URL: "https://router.example.com",
      WEB_ROOT: "/srv/console",
      CLAUDE_CONFIG_ROOT: "/srv/claude",
      ACCOUNT_RECHECK_COOLDOWN_SECONDS: "30",
      ACCOUNT_TEST_NOW_COOLDOWN_SECONDS: "45",
      RETENTION_SESSIONS_HOURS: "6",
      RETENTION_USAGE_DAYS: "7",
      RETENTION_AUDIT_DAYS: "30",
      RETENTION_REVOKED_KEYS_DAYS: "1",
      RETENTION_OAUTH_STATE_MINUTES: "5",
      RETENTION_ORPHAN_CONFIG_DIR_HOURS: "3",
      JANITOR_INTERVAL_MINUTES: "15",
      USAGE_ROLLUP_INTERVAL_MINUTES: "120",
      OAUTH_STATE_PURGE_INTERVAL_MINUTES: "10",
      QUOTA_FLOOR_INTERVAL_MINUTES: "45",
      CONFIG_DIR_REAP_INTERVAL_MINUTES: "90",
      SWEEP_BATCH_SIZE: "500",
      SCHEDULER_JITTER_FRACTION: "0.5",
      ADMIN_SESSION_IDLE_MINUTES: "60",
      ADMIN_SESSION_ABSOLUTE_HOURS: "8",
      ADMIN_LOGIN_MAX_ATTEMPTS: "3",
      ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES: "5",
      ADMIN_LOGIN_LOCKOUT_MINUTES: "30",
      ADMIN_SESSION_SLIDE_FRACTION: "0.25",
      SESSION_COOKIE_INSECURE: "true",
    })

    expect(env.port).toBe(9000)
    expect(env.logLevel).toBe("debug")
    expect(env.trustProxy).toBe(true)
    expect(env.publicUrl).toBe("https://router.example.com")
    expect(env.webRoot).toBe("/srv/console")
    expect(env.claudeConfigRoot).toBe("/srv/claude")
    expect(env.accountRecheckCooldownSeconds).toBe(30)
    expect(env.accountTestNowCooldownSeconds).toBe(45)
    expect(env.retention.sessionsHours).toBe(6)
    expect(env.retention.orphanConfigDirHours).toBe(3)
    expect(env.janitorIntervalMinutes).toBe(15)
    expect(env.scheduler).toEqual({
      usageRollupIntervalMinutes: 120,
      oauthStatePurgeIntervalMinutes: 10,
      quotaFloorIntervalMinutes: 45,
      configDirReapIntervalMinutes: 90,
      sweepBatchSize: 500,
      jitterFraction: 0.5,
    })
    expect(env.adminAuth).toEqual({
      sessionIdleMinutes: 60,
      sessionAbsoluteHours: 8,
      loginMaxAttempts: 3,
      loginAttemptWindowMinutes: 5,
      loginLockoutMinutes: 30,
      sessionSlideFraction: 0.25,
      sessionCookieInsecure: true,
    })
  })

  test("treats an empty variable as unset", () => {
    const env = parseEnv({ ...base, PORT: "", LOG_LEVEL: "", TRUST_PROXY: "" })

    expect(env.port).toBe(8080)
    expect(env.logLevel).toBe("info")
    expect(env.trustProxy).toBe(false)
  })

  describe("admin credential", () => {
    test("uses ADMIN_PASSWORD when it is the only one set", () => {
      expect(parseEnv(base).adminCredential).toEqual({ kind: "password", value: "hunter2" })
    })

    test("ADMIN_PASSWORD_HASH wins when both are set", () => {
      const env = parseEnv({ ...base, ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$abc" })

      expect(env.adminCredential).toEqual({
        kind: "hash",
        value: "$argon2id$v=19$m=65536,t=3,p=4$abc",
      })
    })

    test("boot fails naming both variables when neither is set", () => {
      const { ADMIN_PASSWORD: _omitted, ...withoutPassword } = base
      const error = expectEnvError(withoutPassword)

      expect(error.variables).toEqual(["ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH"])
      expect(error.message).toContain("exactly one of ADMIN_PASSWORD or ADMIN_PASSWORD_HASH")
    })
  })

  describe("ENCRYPTION_KEY", () => {
    test("rejects a key that decodes to fewer than 32 bytes", () => {
      const short = Buffer.alloc(16, 7).toString("base64")
      const error = expectEnvError({ ...base, ENCRYPTION_KEY: short })

      expect(error.variables).toEqual(["ENCRYPTION_KEY"])
      expect(error.message).toContain("32 bytes")
    })

    test("rejects a key that decodes to more than 32 bytes", () => {
      const long = Buffer.alloc(64, 7).toString("base64")

      expect(expectEnvError({ ...base, ENCRYPTION_KEY: long }).variables).toEqual([
        "ENCRYPTION_KEY",
      ])
    })

    test("rejects a value that is not base64 at all", () => {
      expect(expectEnvError({ ...base, ENCRYPTION_KEY: "not a key!!" }).variables).toEqual([
        "ENCRYPTION_KEY",
      ])
    })

    test("accepts exactly 32 bytes of base64", () => {
      expect(parseEnv(base).encryptionKey).toBe(ENCRYPTION_KEY)
    })
  })

  describe("required and malformed variables", () => {
    test("names DATABASE_URL when it is missing", () => {
      const { DATABASE_URL: _omitted, ...withoutDatabase } = base

      expect(expectEnvError(withoutDatabase).variables).toEqual(["DATABASE_URL"])
    })

    test("names ADMIN_USERNAME when it is missing", () => {
      const { ADMIN_USERNAME: _omitted, ...withoutUsername } = base

      expect(expectEnvError(withoutUsername).variables).toEqual(["ADMIN_USERNAME"])
    })

    test("names PORT when it is not a number", () => {
      expect(expectEnvError({ ...base, PORT: "eight-thousand" }).variables).toEqual(["PORT"])
    })

    test("names LOG_LEVEL when it is not one of the four levels", () => {
      expect(expectEnvError({ ...base, LOG_LEVEL: "verbose" }).variables).toEqual(["LOG_LEVEL"])
    })

    test("names PUBLIC_URL when it is not an absolute URL", () => {
      expect(expectEnvError({ ...base, PUBLIC_URL: "router.example.com" }).variables).toEqual([
        "PUBLIC_URL",
      ])
    })

    test("reports every offending variable at once", () => {
      const error = expectEnvError({ ENCRYPTION_KEY: "short", PORT: "nope" })

      expect(error.variables).toContain("DATABASE_URL")
      expect(error.variables).toContain("ADMIN_USERNAME")
      expect(error.variables).toContain("ENCRYPTION_KEY")
      expect(error.variables).toContain("PORT")
    })
  })

  describe("SESSION_COOKIE_INSECURE", () => {
    test("defaults off — the hardened cookie is what an unconfigured router ships", () => {
      expect(parseEnv(base).adminAuth.sessionCookieInsecure).toBe(false)
    })

    test("accepts both spellings of on and of off", () => {
      for (const on of ["true", "1"]) {
        expect(
          parseEnv({ ...base, SESSION_COOKIE_INSECURE: on }).adminAuth.sessionCookieInsecure,
        ).toBe(true)
      }
      for (const off of ["false", "0"]) {
        expect(
          parseEnv({ ...base, SESSION_COOKIE_INSECURE: off }).adminAuth.sessionCookieInsecure,
        ).toBe(false)
      }
    })

    test("a value that is neither fails boot rather than being read as off", () => {
      expect(expectEnvError({ ...base, SESSION_COOKIE_INSECURE: "yes" }).variables).toEqual([
        "SESSION_COOKIE_INSECURE",
      ])
    })
  })

  describe("scheduler knobs", () => {
    test("names USAGE_ROLLUP_INTERVAL_MINUTES when it is not a whole number", () => {
      expect(expectEnvError({ ...base, USAGE_ROLLUP_INTERVAL_MINUTES: "soon" }).variables).toEqual([
        "USAGE_ROLLUP_INTERVAL_MINUTES",
      ])
    })

    test("names OAUTH_STATE_PURGE_INTERVAL_MINUTES when it is not a whole number", () => {
      expect(
        expectEnvError({ ...base, OAUTH_STATE_PURGE_INTERVAL_MINUTES: "-5" }).variables,
      ).toEqual(["OAUTH_STATE_PURGE_INTERVAL_MINUTES"])
    })

    test("names QUOTA_FLOOR_INTERVAL_MINUTES when it is not a whole number", () => {
      expect(expectEnvError({ ...base, QUOTA_FLOOR_INTERVAL_MINUTES: "1.5" }).variables).toEqual([
        "QUOTA_FLOOR_INTERVAL_MINUTES",
      ])
    })

    test("names SWEEP_BATCH_SIZE when it is not a whole number", () => {
      expect(expectEnvError({ ...base, SWEEP_BATCH_SIZE: "lots" }).variables).toEqual([
        "SWEEP_BATCH_SIZE",
      ])
    })

    test("names SCHEDULER_JITTER_FRACTION when it is not a number", () => {
      expect(expectEnvError({ ...base, SCHEDULER_JITTER_FRACTION: "high" }).variables).toEqual([
        "SCHEDULER_JITTER_FRACTION",
      ])
    })

    test("rejects a SCHEDULER_JITTER_FRACTION above 1", () => {
      const error = expectEnvError({ ...base, SCHEDULER_JITTER_FRACTION: "1.5" })

      expect(error.variables).toEqual(["SCHEDULER_JITTER_FRACTION"])
      expect(error.message).toContain("between 0 and 1")
    })

    test("rejects a negative SCHEDULER_JITTER_FRACTION", () => {
      expect(expectEnvError({ ...base, SCHEDULER_JITTER_FRACTION: "-0.1" }).variables).toEqual([
        "SCHEDULER_JITTER_FRACTION",
      ])
    })

    test("accepts SCHEDULER_JITTER_FRACTION at each boundary", () => {
      expect(parseEnv({ ...base, SCHEDULER_JITTER_FRACTION: "0" }).scheduler.jitterFraction).toBe(0)
      expect(parseEnv({ ...base, SCHEDULER_JITTER_FRACTION: "1" }).scheduler.jitterFraction).toBe(1)
    })
  })
})
