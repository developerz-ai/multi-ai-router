import { isAbsolute } from "node:path"
import { z } from "zod"

/**
 * Boot-time environment validation — the reference is
 * docs/idea/09-deployment.md#environment-reference.
 *
 * `parseEnv` is pure: it never reads `process.env` itself, so it is unit-testable
 * and `main.ts` owns the single impure call. A failure names the offending
 * variable; boot exits non-zero rather than starting half-configured.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** Which admin secret is in force. The hash wins when both are set. */
export type AdminCredential =
  | { readonly kind: "hash"; readonly value: string }
  | { readonly kind: "password"; readonly value: string }

export interface RetentionConfig {
  readonly sessionsHours: number
  readonly usageDays: number
  readonly auditDays: number
  readonly revokedKeysDays: number
  readonly oauthStateMinutes: number
}

/**
 * Admin-plane session and login-throttle windows. Grouped like `RetentionConfig`
 * rather than flattened onto `Env`, because they are one policy read by one
 * consumer (`services/admin-auth`).
 *
 * All five are optional: the documented happy path stays three hand-set
 * variables plus `docker compose up`.
 *
 * Deliberately NOT `retention.sessionsHours` — that is the *conversation*
 * sticky-session TTL for routing, a different thing that merely shares a word.
 */
export interface AdminAuthConfig {
  /** Sliding idle window; also the session cookie's `Max-Age`. */
  readonly sessionIdleMinutes: number
  /** Hard cap on total session life regardless of activity. A purely sliding session is one a thief renews forever. */
  readonly sessionAbsoluteHours: number
  /** Failed logins per throttle key before it locks. */
  readonly loginMaxAttempts: number
  /** Failures older than this stop counting toward the lock. */
  readonly loginAttemptWindowMinutes: number
  /** How long a tripped throttle key stays locked. */
  readonly loginLockoutMinutes: number
}

/**
 * The knobs on the request path's two in-memory caches and its off-path writer.
 *
 * Every one of these is a staleness or memory bound that an operator running a
 * large pool may legitimately want to move, which is why none of them is a
 * constant in code (CLAUDE.md non-negotiable 11).
 */
export interface DataPlaneConfig {
  /**
   * How long the warm routing catalog may lag a write made by *another* replica.
   * A write by this replica refreshes it immediately, so this bounds only the
   * multi-replica case.
   */
  readonly catalogRefreshSeconds: number
  /** Verified router keys held in memory. The ceiling is memory, not correctness. */
  readonly keyCacheMax: number
  /** How long a successful key verification is reused. Revocation invalidates immediately. */
  readonly keyCacheTtlSeconds: number
  /**
   * How long a *failed* lookup is remembered. Short on purpose: this is what
   * stops a flood of bad keys from becoming a flood of queries, and a key that
   * was just minted must start working quickly.
   */
  readonly keyCacheNegativeTtlSeconds: number
  /** Usage records held in memory before the writer sheds the oldest. Reporting degrades; traffic does not. */
  readonly usageQueueMax: number
  readonly usageBatchSize: number
  readonly usageFlushIntervalMs: number
}

/**
 * How hard the router tries before it gives up, and how long a failing account stays out.
 *
 * These are the knobs an operator reaches for when their pool's shape does not match the
 * defaults — a two-account deployment wants a different attempt cap than a twenty-account one,
 * and a provider with a slow recovery wants a longer backoff ceiling.
 *
 * One thing no value here can change: **an attempt is never retried after bytes are on the
 * wire.** That is a correctness rule, not a tuning parameter (CLAUDE.md, "Retry a request onto
 * another account after bytes are on the wire — fail honestly").
 */
export interface FailoverConfig {
  /** Distinct accounts tried for one client request, before the honest failure. */
  readonly maxAttempts: number
  /** Consecutive 5xx or connection failures before an account's breaker trips. */
  readonly failureThreshold: number
  /** First cooldown step. Doubles per consecutive failure. */
  readonly baseBackoffMs: number
  /** Ceiling on that doubling, so a long outage does not park an account for hours. */
  readonly maxBackoffMs: number
  /** How long the router waits on one upstream. Long, because a long completion is normal. */
  readonly upstreamTimeoutMs: number
}

/**
 * Scheduler task intervals and tuning.
 *
 * Every interval is config, never a constant in code (CLAUDE.md non-negotiable 11).
 * The actual interval is jittered around the configured value so sweeps never pile
 * onto request spikes or onto each other after a restart.
 */
export interface SchedulerConfig {
  /** Usage record rollup interval, in minutes. */
  readonly usageRollupIntervalMinutes: number
  /** OAuth state (and PKCE verifier) purge interval, in minutes. */
  readonly oauthStatePurgeIntervalMinutes: number
  /** Account quota floor probe interval, in minutes. */
  readonly quotaFloorIntervalMinutes: number
  /** Max rows per bounded-delete sweep. */
  readonly sweepBatchSize: number
  /** Jitter applied to task intervals as a fraction of the interval. E.g., 0.2 means ±20%. */
  readonly jitterFraction: number
}

/** Cross-dialect translation tuning. A ceiling an operator lives with is config, never code. */
export interface TranslationConfig {
  /**
   * The `max_tokens` an Anthropic egress is given when the client's dialect made it optional and
   * the client omitted it. Deliberately generous: a low value truncates an answer the caller never
   * asked to truncate, which is the one failure a default must not cause silently.
   */
  readonly defaultMaxTokens: number
}

export interface Env {
  readonly port: number
  readonly databaseUrl: string
  readonly adminUsername: string
  readonly adminCredential: AdminCredential
  readonly encryptionKey: string
  readonly logLevel: LogLevel
  readonly trustProxy: boolean
  readonly publicUrl: string | null
  /** Parent of the per-Account `CLAUDE_CONFIG_DIR`s — `providers/claude-sdk/config-dir.ts`. */
  readonly claudeConfigRoot: string
  /**
   * Pins the `claude` binary the Agent SDK spawns, bypassing the resolution ladder. Set means
   * *exactly this*: an unusable path fails rather than falling through to some other binary the
   * operator did not name — `providers/claude-sdk/resolve-cli.ts`.
   */
  readonly claudeCliPath: string | null
  /**
   * Bearer token `GET /metrics` demands, or null to leave it open. Null is the right default for
   * a deployment whose metrics port is not routable; see `routes/metrics.ts`.
   */
  readonly metricsToken: string | null
  readonly accountRecheckCooldownSeconds: number
  readonly retention: RetentionConfig
  readonly janitorIntervalMinutes: number
  readonly adminAuth: AdminAuthConfig
  readonly dataPlane: DataPlaneConfig
  readonly failover: FailoverConfig
  readonly scheduler: SchedulerConfig
  readonly translation: TranslationConfig
}

/**
 * Boot configuration failure. Deliberately not a `RouterError` from
 * `@multi-ai-router/core`: those map to an HTTP status, and this one never
 * becomes a response — the process exits before the listener opens.
 */
export class EnvValidationError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[]) {
    super(message)
    this.name = "EnvValidationError"
    this.variables = variables
  }
}

const ENCRYPTION_KEY_BYTES = 32
const BASE64_SHAPE = /^[A-Za-z0-9+/_-]+={0,2}$/

/** Decodes a base64 (or base64url) `ENCRYPTION_KEY`, or null when it is not 32 bytes. */
export function decodeEncryptionKey(value: string): Uint8Array | null {
  const normalized = value.trim()
  if (normalized.length === 0 || !BASE64_SHAPE.test(normalized)) return null
  const bytes = Buffer.from(normalized, "base64")
  return bytes.byteLength === ENCRYPTION_KEY_BYTES ? new Uint8Array(bytes) : null
}

const nonEmpty = z.string().min(1)
const wholeNumber = z.string().regex(/^\d+$/, "must be a whole number").transform(Number)
const flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")
const absoluteUrl = z.string().refine((v) => URL.canParse(v), "must be an absolute URL")
const encryptionKey = z
  .string()
  .refine(
    (v) => decodeEncryptionKey(v) !== null,
    `must decode to ${ENCRYPTION_KEY_BYTES} bytes — generate with: openssl rand -base64 32`,
  )

const envSchema = z
  .object({
    PORT: wholeNumber.optional(),
    DATABASE_URL: nonEmpty,
    ADMIN_USERNAME: nonEmpty,
    ADMIN_PASSWORD: nonEmpty.optional(),
    ADMIN_PASSWORD_HASH: nonEmpty.optional(),
    ENCRYPTION_KEY: encryptionKey,
    LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
    TRUST_PROXY: flag.optional(),
    PUBLIC_URL: absoluteUrl.optional(),
    CLAUDE_CONFIG_ROOT: nonEmpty.refine(isAbsolute, "must be an absolute path").optional(),
    CLAUDE_CLI_PATH: nonEmpty.optional(),
    METRICS_TOKEN: nonEmpty.optional(),
    ACCOUNT_RECHECK_COOLDOWN_SECONDS: wholeNumber.optional(),
    RETENTION_SESSIONS_HOURS: wholeNumber.optional(),
    RETENTION_USAGE_DAYS: wholeNumber.optional(),
    RETENTION_AUDIT_DAYS: wholeNumber.optional(),
    RETENTION_REVOKED_KEYS_DAYS: wholeNumber.optional(),
    RETENTION_OAUTH_STATE_MINUTES: wholeNumber.optional(),
    JANITOR_INTERVAL_MINUTES: wholeNumber.optional(),
    USAGE_ROLLUP_INTERVAL_MINUTES: wholeNumber.optional(),
    OAUTH_STATE_PURGE_INTERVAL_MINUTES: wholeNumber.optional(),
    QUOTA_FLOOR_INTERVAL_MINUTES: wholeNumber.optional(),
    SWEEP_BATCH_SIZE: wholeNumber.optional(),
    SCHEDULER_JITTER_FRACTION: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "must be a number")
      .transform(Number)
      .refine((v) => v >= 0 && v <= 1, "must be between 0 and 1")
      .optional(),
    ADMIN_SESSION_IDLE_MINUTES: wholeNumber.optional(),
    ADMIN_SESSION_ABSOLUTE_HOURS: wholeNumber.optional(),
    ADMIN_LOGIN_MAX_ATTEMPTS: wholeNumber.optional(),
    ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES: wholeNumber.optional(),
    ADMIN_LOGIN_LOCKOUT_MINUTES: wholeNumber.optional(),
    CATALOG_REFRESH_SECONDS: wholeNumber.optional(),
    KEY_CACHE_MAX: wholeNumber.optional(),
    KEY_CACHE_TTL_SECONDS: wholeNumber.optional(),
    KEY_CACHE_NEGATIVE_TTL_SECONDS: wholeNumber.optional(),
    USAGE_QUEUE_MAX: wholeNumber.optional(),
    USAGE_BATCH_SIZE: wholeNumber.optional(),
    USAGE_FLUSH_INTERVAL_MS: wholeNumber.optional(),
    ROUTING_MAX_ATTEMPTS: wholeNumber.optional(),
    ROUTING_FAILURE_THRESHOLD: wholeNumber.optional(),
    ROUTING_BASE_BACKOFF_MS: wholeNumber.optional(),
    ROUTING_MAX_BACKOFF_MS: wholeNumber.optional(),
    UPSTREAM_TIMEOUT_MS: wholeNumber.optional(),
    TRANSLATE_DEFAULT_MAX_TOKENS: wholeNumber.optional(),
  })
  .transform((raw, ctx): Env => {
    // Precedence: ADMIN_PASSWORD_HASH wins when both are set; exactly one is required.
    const hash = raw.ADMIN_PASSWORD_HASH
    const password = raw.ADMIN_PASSWORD
    let adminCredential: AdminCredential
    if (hash !== undefined) {
      adminCredential = { kind: "hash", value: hash }
    } else if (password !== undefined) {
      adminCredential = { kind: "password", value: password }
    } else {
      const message = "exactly one of ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be set"
      ctx.addIssue({ code: "custom", path: ["ADMIN_PASSWORD"], message })
      ctx.addIssue({ code: "custom", path: ["ADMIN_PASSWORD_HASH"], message })
      return z.NEVER
    }

    return {
      port: raw.PORT ?? 8080,
      databaseUrl: raw.DATABASE_URL,
      adminUsername: raw.ADMIN_USERNAME,
      adminCredential,
      encryptionKey: raw.ENCRYPTION_KEY,
      logLevel: raw.LOG_LEVEL ?? "info",
      trustProxy: raw.TRUST_PROXY ?? false,
      publicUrl: raw.PUBLIC_URL ?? null,
      claudeConfigRoot: raw.CLAUDE_CONFIG_ROOT ?? "/data/claude",
      claudeCliPath: raw.CLAUDE_CLI_PATH ?? null,
      metricsToken: raw.METRICS_TOKEN ?? null,
      accountRecheckCooldownSeconds: raw.ACCOUNT_RECHECK_COOLDOWN_SECONDS ?? 60,
      retention: {
        sessionsHours: raw.RETENTION_SESSIONS_HOURS ?? 24,
        usageDays: raw.RETENTION_USAGE_DAYS ?? 90,
        auditDays: raw.RETENTION_AUDIT_DAYS ?? 365,
        revokedKeysDays: raw.RETENTION_REVOKED_KEYS_DAYS ?? 30,
        oauthStateMinutes: raw.RETENTION_OAUTH_STATE_MINUTES ?? 10,
      },
      janitorIntervalMinutes: raw.JANITOR_INTERVAL_MINUTES ?? 60,
      scheduler: {
        usageRollupIntervalMinutes: raw.USAGE_ROLLUP_INTERVAL_MINUTES ?? 60,
        oauthStatePurgeIntervalMinutes: raw.OAUTH_STATE_PURGE_INTERVAL_MINUTES ?? 5,
        quotaFloorIntervalMinutes: raw.QUOTA_FLOOR_INTERVAL_MINUTES ?? 30,
        sweepBatchSize: raw.SWEEP_BATCH_SIZE ?? 1_000,
        jitterFraction: raw.SCHEDULER_JITTER_FRACTION ?? 0.2,
      },
      adminAuth: {
        sessionIdleMinutes: raw.ADMIN_SESSION_IDLE_MINUTES ?? 480,
        sessionAbsoluteHours: raw.ADMIN_SESSION_ABSOLUTE_HOURS ?? 24,
        loginMaxAttempts: raw.ADMIN_LOGIN_MAX_ATTEMPTS ?? 5,
        loginAttemptWindowMinutes: raw.ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES ?? 15,
        loginLockoutMinutes: raw.ADMIN_LOGIN_LOCKOUT_MINUTES ?? 15,
      },
      // Defaults mirror the layer constants they override, so an unset variable
      // and a variable set to the default behave identically.
      dataPlane: {
        catalogRefreshSeconds: raw.CATALOG_REFRESH_SECONDS ?? 30,
        keyCacheMax: raw.KEY_CACHE_MAX ?? 4_096,
        keyCacheTtlSeconds: raw.KEY_CACHE_TTL_SECONDS ?? 60,
        keyCacheNegativeTtlSeconds: raw.KEY_CACHE_NEGATIVE_TTL_SECONDS ?? 5,
        usageQueueMax: raw.USAGE_QUEUE_MAX ?? 10_000,
        usageBatchSize: raw.USAGE_BATCH_SIZE ?? 200,
        usageFlushIntervalMs: raw.USAGE_FLUSH_INTERVAL_MS ?? 1_000,
      },
      failover: {
        maxAttempts: raw.ROUTING_MAX_ATTEMPTS ?? 3,
        failureThreshold: raw.ROUTING_FAILURE_THRESHOLD ?? 3,
        baseBackoffMs: raw.ROUTING_BASE_BACKOFF_MS ?? 1_000,
        maxBackoffMs: raw.ROUTING_MAX_BACKOFF_MS ?? 300_000,
        upstreamTimeoutMs: raw.UPSTREAM_TIMEOUT_MS ?? 600_000,
      },
      translation: {
        defaultMaxTokens: raw.TRANSLATE_DEFAULT_MAX_TOKENS ?? 4_096,
      },
    }
  })

/**
 * Validates a raw environment map into `Env`.
 *
 * @throws EnvValidationError naming every offending variable.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(compact(raw))
  if (result.success) return result.data
  throw toEnvValidationError(result.error)
}

/** An unset variable and one set to the empty string mean the same thing to an operator. */
function compact(raw: Record<string, string | undefined>): Record<string, string> {
  const compacted: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed.length > 0) compacted[name] = trimmed
  }
  return compacted
}

function toEnvValidationError(error: z.ZodError): EnvValidationError {
  const variables: string[] = []
  const lines: string[] = []
  for (const issue of error.issues) {
    const name = issue.path.map(String).join(".") || "(environment)"
    if (!variables.includes(name)) variables.push(name)
    // Every raw value is a string, so the only `invalid_type` here is an absent variable.
    lines.push(`  ${name}: ${issue.code === "invalid_type" ? "is required" : issue.message}`)
  }
  const message = `Invalid environment configuration:\n${lines.join("\n")}`
  return new EnvValidationError(message, variables)
}
