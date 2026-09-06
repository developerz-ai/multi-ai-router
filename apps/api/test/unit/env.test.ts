import { describe, expect, test } from "bun:test"
import { generateRouterKey, ROUTER_KEY_PREFIX } from "@multi-ai-router/core"
import {
  DATABASE_POOL_DEFAULTS,
  PG_MAX_BIND_PARAMETERS,
  USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
  USAGE_RECORD_MAX_BATCH_ROWS,
} from "@multi-ai-router/db"
import type { z } from "zod"
import { ENV_FIELDS, EnvValidationError, parseEnv, ZERO_IS_LEGAL } from "../../src/config/env"
import { ADMIN_API_TOKEN_MIN_LENGTH } from "../../src/services/admin-auth"
import { DEFAULT_MAX_BODY_BYTES } from "../../src/services/dataplane"

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")

/** The minimum an operator must set by hand, plus the DATABASE_URL compose supplies. */
const base: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://router:router@postgres:5432/router",
  ADMIN_OIDC_ISSUER_URL: "https://sso.test",
  ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
  ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
  ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
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
    expect(env.shutdownDrainMs).toBe(15_000)
    expect(env.shutdownReadyGraceMs).toBe(0)
    // Restated from the package that opens the pool, so an unset variable and the documented
    // default cannot become two numbers that merely used to agree.
    expect(env.databasePool).toEqual(DATABASE_POOL_DEFAULTS)
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
      usageDailyDays: 730,
      auditDays: 365,
      taskRunsDays: 30,
      revokedKeysDays: 30,
      oauthStateMinutes: 10,
      orphanConfigDirHours: 24,
      sdkTranscriptHours: 24,
    })
    expect(env.scheduler).toEqual({
      usageRollupIntervalMinutes: 60,
      oauthStatePurgeIntervalMinutes: 5,
      quotaFloorIntervalMinutes: 30,
      configDirReapIntervalMinutes: 360,
      sdkTranscriptSweepIntervalMinutes: 60,
      adminSessionPurgeIntervalMinutes: 30,
      // Daily sweep, 7-day threshold — comfortably inside a Claude subscription's ~4-week
      // refresh-token life, which is the window this exists to stay ahead of.
      idleAccountProbeIntervalMinutes: 360,
      idleAccountAfterDays: 7,
      idleAccountProbeBatchSize: 5,
      // Off: a billed keepalive cannot move a subscription's refresh-token cliff.
      idleAccountProbePaidTurn: false,
      // Hourly, and a bigger batch than the keepalive's five: these are plain GETs against a
      // listing endpoint, not billed turns.
      modelCatalogRefreshIntervalMinutes: 60,
      modelCatalogRefreshBatchSize: 25,
      sweepBatchSize: 1_000,
      jitterFraction: 0.2,
    })
    expect(env.adminAuth).toEqual({
      sessionIdleMinutes: 43_200,
      sessionAbsoluteHours: 720,
      loginMaxAttempts: 5,
      loginAttemptWindowMinutes: 15,
      loginLockoutMinutes: 15,
      sessionTouchIntervalSeconds: 60,
      sessionCacheMax: 1_000,
      sessionCookieInsecure: false,
      localLoginAllowPublic: false,
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
      RETENTION_USAGE_DAILY_DAYS: "400",
      RETENTION_AUDIT_DAYS: "30",
      RETENTION_TASK_RUNS_DAYS: "14",
      RETENTION_REVOKED_KEYS_DAYS: "1",
      RETENTION_OAUTH_STATE_MINUTES: "5",
      RETENTION_ORPHAN_CONFIG_DIR_HOURS: "3",
      RETENTION_SDK_TRANSCRIPT_HOURS: "12",
      JANITOR_INTERVAL_MINUTES: "15",
      USAGE_ROLLUP_INTERVAL_MINUTES: "120",
      OAUTH_STATE_PURGE_INTERVAL_MINUTES: "10",
      QUOTA_FLOOR_INTERVAL_MINUTES: "45",
      CONFIG_DIR_REAP_INTERVAL_MINUTES: "90",
      SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES: "30",
      IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES: "720",
      IDLE_ACCOUNT_AFTER_DAYS: "3",
      IDLE_ACCOUNT_PROBE_BATCH_SIZE: "2",
      IDLE_ACCOUNT_PROBE_PAID_TURN: "true",
      MODEL_CATALOG_REFRESH_INTERVAL_MINUTES: "30",
      MODEL_CATALOG_REFRESH_BATCH_SIZE: "8",
      ADMIN_SESSION_PURGE_INTERVAL_MINUTES: "20",
      SWEEP_BATCH_SIZE: "500",
      SCHEDULER_JITTER_FRACTION: "0.5",
      ADMIN_SESSION_IDLE_MINUTES: "60",
      ADMIN_SESSION_ABSOLUTE_HOURS: "8",
      ADMIN_LOGIN_MAX_ATTEMPTS: "3",
      ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES: "5",
      ADMIN_LOGIN_LOCKOUT_MINUTES: "30",
      ADMIN_SESSION_TOUCH_INTERVAL_SECONDS: "5",
      ADMIN_SESSION_CACHE_MAX: "50",
      SESSION_COOKIE_INSECURE: "true",
      DB_POOL_MAX: "25",
      DB_POOL_IDLE_TIMEOUT_SECONDS: "120",
      DB_POOL_CONNECT_TIMEOUT_SECONDS: "20",
      DB_POOL_MAX_LIFETIME_SECONDS: "600",
      DB_POOL_CLOSE_TIMEOUT_SECONDS: "9",
      SHUTDOWN_READY_GRACE_MS: "20000",
    })

    expect(env.port).toBe(9000)
    expect(env.logLevel).toBe("debug")
    expect(env.trustProxy).toBe(true)
    expect(env.publicUrl).toBe("https://router.example.com")
    expect(env.webRoot).toBe("/srv/console")
    expect(env.claudeConfigRoot).toBe("/srv/claude")
    expect(env.accountRecheckCooldownSeconds).toBe(30)
    expect(env.accountTestNowCooldownSeconds).toBe(45)
    expect(env.shutdownReadyGraceMs).toBe(20_000)
    expect(env.databasePool).toEqual({
      maxConnections: 25,
      idleTimeoutSeconds: 120,
      connectTimeoutSeconds: 20,
      maxLifetimeSeconds: 600,
      closeTimeoutSeconds: 9,
    })
    expect(env.retention.sessionsHours).toBe(6)
    expect(env.retention.usageDailyDays).toBe(400)
    expect(env.retention.taskRunsDays).toBe(14)
    expect(env.retention.orphanConfigDirHours).toBe(3)
    expect(env.retention.sdkTranscriptHours).toBe(12)
    expect(env.janitorIntervalMinutes).toBe(15)
    expect(env.scheduler).toEqual({
      usageRollupIntervalMinutes: 120,
      oauthStatePurgeIntervalMinutes: 10,
      quotaFloorIntervalMinutes: 45,
      configDirReapIntervalMinutes: 90,
      sdkTranscriptSweepIntervalMinutes: 30,
      adminSessionPurgeIntervalMinutes: 20,
      idleAccountProbeIntervalMinutes: 720,
      idleAccountAfterDays: 3,
      idleAccountProbeBatchSize: 2,
      idleAccountProbePaidTurn: true,
      modelCatalogRefreshIntervalMinutes: 30,
      modelCatalogRefreshBatchSize: 8,
      sweepBatchSize: 500,
      jitterFraction: 0.5,
    })
    expect(env.adminAuth).toEqual({
      sessionIdleMinutes: 60,
      sessionAbsoluteHours: 8,
      loginMaxAttempts: 3,
      loginAttemptWindowMinutes: 5,
      loginLockoutMinutes: 30,
      sessionTouchIntervalSeconds: 5,
      sessionCacheMax: 50,
      sessionCookieInsecure: true,
      localLoginAllowPublic: false,
    })
  })

  test("treats an empty variable as unset", () => {
    const env = parseEnv({ ...base, PORT: "", LOG_LEVEL: "", TRUST_PROXY: "" })

    expect(env.port).toBe(8080)
    expect(env.logLevel).toBe("info")
    expect(env.trustProxy).toBe(false)
  })

  describe("admin OIDC", () => {
    test("carries the four required fields and the optional ones", () => {
      const env = parseEnv({
        ...base,
        ADMIN_OIDC_CLIENT_SECRET: "shh",
        ADMIN_OIDC_ADMIN_SUBJECT: "subject-123",
        ADMIN_OIDC_SCOPES: "openid email",
        ADMIN_OIDC_CLOCK_SKEW_SECONDS: "30",
      })

      expect(env.adminOidc).toEqual({
        issuerUrl: "https://sso.test",
        clientId: "multi-ai-router-test",
        clientSecret: "shh",
        redirectUri: "https://router.test/api/admin/auth/oidc/callback",
        adminEmails: ["admin@test"],
        adminSubject: "subject-123",
        scopes: ["openid", "email"],
        clockSkewSeconds: 30,
      })
    })

    test("defaults the optional fields", () => {
      const env = parseEnv(base)

      expect(env.adminOidc?.clientSecret).toBeNull()
      expect(env.adminOidc?.adminSubject).toBeNull()
      expect(env.adminOidc?.scopes).toEqual(["openid", "profile", "email"])
      expect(env.adminOidc?.clockSkewSeconds).toBe(60)
    })

    test("no OIDC variables at all parses to null — local login decides at boot", () => {
      const env = parseEnv({
        DATABASE_URL: "postgres://router:router@postgres:5432/router",
        ENCRYPTION_KEY,
      })

      expect(env.adminOidc).toBeNull()
    })

    test("a partial OIDC block fails naming every missing field", () => {
      const error = expectEnvError({
        DATABASE_URL: "postgres://router:router@postgres:5432/router",
        ADMIN_OIDC_ISSUER_URL: "https://sso.test",
        ENCRYPTION_KEY,
      })

      const missing = ["ADMIN_OIDC_CLIENT_ID", "ADMIN_OIDC_REDIRECT_URI", "ADMIN_OIDC_ADMIN_EMAIL"]
      for (const name of missing) expect(error.variables).toContain(name)
      expect(error.variables).not.toContain("ADMIN_OIDC_ISSUER_URL")
      expect(error.message).toContain("docs/idea/13-admin-oidc.md")
    })

    test("ADMIN_OIDC_ADMIN_EMAIL is a comma-separated allowlist, normalized and deduplicated", () => {
      const env = parseEnv({
        ...base,
        ADMIN_OIDC_ADMIN_EMAIL:
          " Ivann@Developerz.ai , sebastian@developerz.ai ,ivann@developerz.ai, ",
      })

      // Lowercased here so the flow compares two already-normalized values; deduplicated so a
      // repeated entry cannot make the allowlist look wider than the humans it admits; the trailing
      // empty entry is dropped rather than becoming an email nothing can equal.
      expect(env.adminOidc?.adminEmails).toEqual(["ivann@developerz.ai", "sebastian@developerz.ai"])
    })

    test("an ADMIN_OIDC_ADMIN_EMAIL that names no email at all is refused", () => {
      // Non-empty, so the all-or-nothing check above is satisfied, yet it configures an allowlist
      // nobody can satisfy. Left to boot, every sign-in would fail the principal check and read as
      // a broken identity provider rather than a typo here.
      const error = expectEnvError({ ...base, ADMIN_OIDC_ADMIN_EMAIL: " , " })

      expect(error.variables).toContain("ADMIN_OIDC_ADMIN_EMAIL")
      expect(error.message).toContain("docs/idea/13-admin-oidc.md")
    })

    test("ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC is a flag, off by default", () => {
      expect(parseEnv(base).adminAuth.localLoginAllowPublic).toBe(false)
      expect(
        parseEnv({ ...base, ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC: "true" }).adminAuth
          .localLoginAllowPublic,
      ).toBe(true)
    })
  })

  /**
   * The admin plane's non-browser credential. Both rules are boot failures rather than warnings
   * for the same reason: each produces a control plane that *looks* configured. A short token is
   * one nothing rate-limits and anything can guess; a router-prefixed one is refused by the admin
   * guard before it is ever compared, so it authenticates nothing while reading as correct.
   */
  describe("ADMIN_API_TOKEN", () => {
    const token = "a".repeat(ADMIN_API_TOKEN_MIN_LENGTH)

    test("is null unless the operator sets one — the plane stays browser-only by default", () => {
      expect(parseEnv(base).adminApiToken).toBeNull()
      expect(parseEnv({ ...base, ADMIN_API_TOKEN: "" }).adminApiToken).toBeNull()
    })

    test("is taken as given when it clears both rules", () => {
      expect(parseEnv({ ...base, ADMIN_API_TOKEN: token }).adminApiToken).toBe(token)
    })

    test("boot refuses a token short enough to guess, naming the variable", () => {
      const error = expectEnvError({
        ...base,
        ADMIN_API_TOKEN: "a".repeat(ADMIN_API_TOKEN_MIN_LENGTH - 1),
      })

      expect(error.variables).toEqual(["ADMIN_API_TOKEN"])
      expect(error.message).toContain(`at least ${ADMIN_API_TOKEN_MIN_LENGTH} characters`)
    })

    test("boot refuses a token wearing the router-key prefix", () => {
      const error = expectEnvError({ ...base, ADMIN_API_TOKEN: generateRouterKey() })

      expect(error.variables).toEqual(["ADMIN_API_TOKEN"])
      expect(error.message).toContain(ROUTER_KEY_PREFIX)
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

  describe("failover and breaker knobs", () => {
    test("every one of them has a documented default", () => {
      expect(parseEnv(base).failover).toEqual({
        // Undefined is the documented default and not a gap: the ceiling is "every eligible
        // account", which only the failover chain can count (`routing/failover.ts`).
        maxAttempts: undefined,
        failureThreshold: 3,
        baseBackoffMs: 1_000,
        maxBackoffMs: 300_000,
        halfOpenHoldMs: 30_000,
        unknownResetRetryAfterSeconds: 30,
        upstreamTimeoutMs: 600_000,
        boundAccountCoolingDown: "fail",
      })
    })

    test("the operator's numbers are the ones parsed, not the module's", () => {
      // These three were parsed at boot and read by nothing for the whole life of the breaker.
      // The assertion that matters is downstream — `health.test.ts` proves they reach a transition —
      // but this is the half that proves the operator's value survives the parse at all.
      const env = parseEnv({
        ...base,
        ROUTING_FAILURE_THRESHOLD: "7",
        ROUTING_BASE_BACKOFF_MS: "250",
        ROUTING_MAX_BACKOFF_MS: "90000",
        ROUTING_HALF_OPEN_HOLD_MS: "5000",
      })

      expect(env.failover).toMatchObject({
        failureThreshold: 7,
        baseBackoffMs: 250,
        maxBackoffMs: 90_000,
        halfOpenHoldMs: 5_000,
      })
    })

    test("a zero half-open hold is refused: a gate that never holds is not a gate", () => {
      expect(expectEnvError({ ...base, ROUTING_HALF_OPEN_HOLD_MS: "0" }).variables).toEqual([
        "ROUTING_HALF_OPEN_HOLD_MS",
      ])
    })

    test("ROUTING_BOUND_ACCOUNT_COOLING_DOWN takes the operator's word, literally", () => {
      expect(
        parseEnv({ ...base, ROUTING_BOUND_ACCOUNT_COOLING_DOWN: "rebind" }).failover
          .boundAccountCoolingDown,
      ).toBe("rebind")
    })

    test("anything but `fail` or `rebind` is refused by name", () => {
      expect(
        expectEnvError({ ...base, ROUTING_BOUND_ACCOUNT_COOLING_DOWN: "ignore" }).variables,
      ).toEqual(["ROUTING_BOUND_ACCOUNT_COOLING_DOWN"])
    })
  })

  describe("SHUTDOWN_DRAIN_MS", () => {
    test("the operator's number is the one parsed", () => {
      expect(parseEnv({ ...base, SHUTDOWN_DRAIN_MS: "45000" }).shutdownDrainMs).toBe(45_000)
    })

    test("zero is legal: it means close in-flight responses without waiting", () => {
      expect(parseEnv({ ...base, SHUTDOWN_DRAIN_MS: "0" }).shutdownDrainMs).toBe(0)
    })

    test("a value that is not a whole number of milliseconds is refused", () => {
      expect(expectEnvError({ ...base, SHUTDOWN_DRAIN_MS: "30s" }).variables).toEqual([
        "SHUTDOWN_DRAIN_MS",
      ])
    })
  })

  describe("MAX_REQUEST_BODY_BYTES", () => {
    test("defaults to the reader's own ceiling, so unset and set-to-the-default agree", () => {
      expect(parseEnv(base).dataPlane.maxRequestBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES)
    })

    test("the operator's number is the one parsed", () => {
      const env = parseEnv({ ...base, MAX_REQUEST_BODY_BYTES: "1048576" })
      expect(env.dataPlane.maxRequestBodyBytes).toBe(1_048_576)
    })

    test("a zero ceiling is refused: a router that reads nothing serves nothing", () => {
      expect(expectEnvError({ ...base, MAX_REQUEST_BODY_BYTES: "0" }).variables).toEqual([
        "MAX_REQUEST_BODY_BYTES",
      ])
    })

    test("names it when it is not a whole number of bytes", () => {
      expect(expectEnvError({ ...base, MAX_REQUEST_BODY_BYTES: "32MB" }).variables).toEqual([
        "MAX_REQUEST_BODY_BYTES",
      ])
    })
  })

  describe("USAGE_BATCH_SIZE", () => {
    test("the operator's number is the one parsed", () => {
      expect(parseEnv({ ...base, USAGE_BATCH_SIZE: "500" }).dataPlane.usageBatchSize).toBe(500)
    })

    test("accepts the largest batch Postgres can bind", () => {
      const env = parseEnv({ ...base, USAGE_BATCH_SIZE: String(USAGE_RECORD_MAX_BATCH_ROWS) })
      expect(env.dataPlane.usageBatchSize).toBe(USAGE_RECORD_MAX_BATCH_ROWS)
    })

    test("refuses one row past it, rather than losing every usage record forever", () => {
      const over = String(USAGE_RECORD_MAX_BATCH_ROWS + 1)
      expect(expectEnvError({ ...base, USAGE_BATCH_SIZE: over }).variables).toEqual([
        "USAGE_BATCH_SIZE",
      ])
    })

    test("shows the arithmetic, so the ceiling is a fact and not a magic number", () => {
      const error = expectEnvError({
        ...base,
        USAGE_BATCH_SIZE: String(USAGE_RECORD_MAX_BATCH_ROWS + 1),
      })

      expect(error.message).toContain(String(PG_MAX_BIND_PARAMETERS))
      expect(error.message).toContain(String(USAGE_RECORD_BIND_PARAMETERS_PER_ROW))
      expect(error.message).toContain(
        `${PG_MAX_BIND_PARAMETERS} / ${USAGE_RECORD_BIND_PARAMETERS_PER_ROW} = ${USAGE_RECORD_MAX_BATCH_ROWS}`,
      )
    })

    test("refuses a batch of zero: the drain takes nothing and the queue only sheds", () => {
      expect(expectEnvError({ ...base, USAGE_BATCH_SIZE: "0" }).variables).toEqual([
        "USAGE_BATCH_SIZE",
      ])
    })

    test("names it when it is not a whole number of rows", () => {
      expect(expectEnvError({ ...base, USAGE_BATCH_SIZE: "2k" }).variables).toEqual([
        "USAGE_BATCH_SIZE",
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

  /**
   * The drift guard behind `fields.ts`'s zero policy.
   *
   * A numeric knob at zero is rarely "off" — it is a sweep that deletes the table it was pointed
   * at, an interval that re-arms every millisecond, a cache that answers nothing, a breaker that
   * never holds. None of those log anything, and traffic keeps flowing, so the only symptom is an
   * absence somebody eventually notices. This walks every numeric field in the schema and demands
   * each one either refuse zero at boot or appear in `ZERO_IS_LEGAL` with what zero means there.
   *
   * It is deliberately derived from the schema rather than a list kept beside it: a knob added
   * without a thought about zero fails here, which is the only moment anyone is looking.
   */
  /**
   * The two-tier usage retention only works while the tiers are the right way round: raw rows
   * expire first and the daily aggregates outlive them. Reversed, the janitor deletes rolled days
   * whose raw rows are still there and the rollup writes them straight back on its next tick —
   * two sweeps fighting forever, with no symptom an operator would connect to either variable.
   */
  describe("RETENTION_USAGE_DAILY_DAYS", () => {
    test("refuses a window narrower than the raw one, and names both", () => {
      const error = expectEnvError({
        ...base,
        RETENTION_USAGE_DAYS: "90",
        RETENTION_USAGE_DAILY_DAYS: "30",
      })

      expect(error.variables).toEqual(["RETENTION_USAGE_DAILY_DAYS"])
      expect(error.message).toContain("RETENTION_USAGE_DAYS (90)")
    })

    test("refuses a raw window widened past the default aggregate one", () => {
      // The same conflict written the other way round: the operator moved only the raw window,
      // and nothing warned them the aggregates it feeds are the shorter of the two.
      expect(expectEnvError({ ...base, RETENTION_USAGE_DAYS: "800" }).variables).toEqual([
        "RETENTION_USAGE_DAILY_DAYS",
      ])
    })

    test("accepts the two windows equal — the aggregates need only not be shorter", () => {
      const env = parseEnv({
        ...base,
        RETENTION_USAGE_DAYS: "60",
        RETENTION_USAGE_DAILY_DAYS: "60",
      })
      expect(env.retention.usageDailyDays).toBe(60)
    })
  })

  describe("zero is a decision, never an accident", () => {
    /**
     * A field is numeric when *some* legal value parses to a number — the flags, enums and
     * strings drop out. Two probes, not one: a whole-number field refuses `0.5`, and a fraction
     * with an exclusive upper bound refuses `1`, so either alone would quietly under-count and
     * leave the knobs it missed unguarded.
     */
    const numericVariables = Object.entries(ENV_FIELDS)
      .filter(([, field]) =>
        ["1", "0.5"].some((probe) => {
          const parsed = (field as z.ZodType).safeParse(probe)
          return parsed.success && typeof parsed.data === "number"
        }),
      )
      .map(([name]) => name)

    test("finds the numeric knobs it is supposed to be guarding", () => {
      // A guard that silently matched nothing would pass forever. The exact count is not the
      // point; that it is the bulk of the schema is.
      expect(numericVariables.length).toBeGreaterThan(30)
      expect(numericVariables).toContain("SWEEP_BATCH_SIZE")
      expect(numericVariables).toContain("ADMIN_SESSION_TOUCH_INTERVAL_SECONDS")
      // The one a single probe misses: it is a fraction, so `0.5` reaches it, and its upper
      // bound is exclusive, so `1` does not.
      expect(numericVariables).toContain("OAUTH_REFRESH_LEAD_FRACTION")
      expect(numericVariables).not.toContain("TRUST_PROXY")
      expect(numericVariables).not.toContain("LOG_LEVEL")
    })

    for (const name of numericVariables) {
      const zeroMeansSomething = ZERO_IS_LEGAL.get(name)

      if (zeroMeansSomething === undefined) {
        test(`${name} refuses 0, because there it is a kill switch`, () => {
          expect(expectEnvError({ ...base, [name]: "0" }).variables).toEqual([name])
        })
        continue
      }

      test(`${name} accepts 0: ${zeroMeansSomething}`, () => {
        expect(() => parseEnv({ ...base, [name]: "0" })).not.toThrow()
      })
    }

    test("every documented exception is a variable this schema still parses as a number", () => {
      // Keeps the list from outliving its entries: renaming a knob, or tightening one to
      // `atLeastOne`, has to take its exception with it.
      for (const [name, reason] of ZERO_IS_LEGAL) {
        expect(numericVariables).toContain(name)
        expect(reason.length).toBeGreaterThan(0)
      }
    })
  })
})

/**
 * The keepalive margin has to span a whole gap between sweeps.
 *
 * A token expiring after this tick's margin but before the next tick is one no sweep ever sees in
 * time. Shipped first as a flat 60 minutes against a 6-hour sweep, which meant an account expiring
 * 2 h 49 m out was skipped now and already dead by the next tick — the keepalive would never have
 * fired for it at all.
 */
describe("the credential keepalive margin", () => {
  test("defaults to one sweep interval plus slack, not a fixed hour", () => {
    const env = parseEnv({ ...base })
    expect(env.claudeSdkCredentialKeepaliveBeforeMinutes).toBe(
      env.scheduler.idleAccountProbeIntervalMinutes + 30,
    )
  })

  test("follows a retuned sweep interval, so the two cannot drift apart", () => {
    const env = parseEnv({ ...base, IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES: "120" })
    expect(env.claudeSdkCredentialKeepaliveBeforeMinutes).toBe(150)
  })

  test("an explicit margin still wins", () => {
    const env = parseEnv({ ...base, CLAUDE_SDK_CREDENTIAL_KEEPALIVE_BEFORE_MINUTES: "45" })
    expect(env.claudeSdkCredentialKeepaliveBeforeMinutes).toBe(45)
  })
})
