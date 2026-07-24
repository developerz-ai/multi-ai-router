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

export interface Env {
  readonly port: number
  readonly databaseUrl: string
  readonly adminUsername: string
  readonly adminCredential: AdminCredential
  readonly encryptionKey: string
  readonly logLevel: LogLevel
  readonly trustProxy: boolean
  readonly publicUrl: string | null
  readonly claudeConfigRoot: string
  readonly accountRecheckCooldownSeconds: number
  readonly retention: RetentionConfig
  readonly janitorIntervalMinutes: number
  readonly adminAuth: AdminAuthConfig
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
    CLAUDE_CONFIG_ROOT: nonEmpty.optional(),
    ACCOUNT_RECHECK_COOLDOWN_SECONDS: wholeNumber.optional(),
    RETENTION_SESSIONS_HOURS: wholeNumber.optional(),
    RETENTION_USAGE_DAYS: wholeNumber.optional(),
    RETENTION_AUDIT_DAYS: wholeNumber.optional(),
    RETENTION_REVOKED_KEYS_DAYS: wholeNumber.optional(),
    RETENTION_OAUTH_STATE_MINUTES: wholeNumber.optional(),
    JANITOR_INTERVAL_MINUTES: wholeNumber.optional(),
    ADMIN_SESSION_IDLE_MINUTES: wholeNumber.optional(),
    ADMIN_SESSION_ABSOLUTE_HOURS: wholeNumber.optional(),
    ADMIN_LOGIN_MAX_ATTEMPTS: wholeNumber.optional(),
    ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES: wholeNumber.optional(),
    ADMIN_LOGIN_LOCKOUT_MINUTES: wholeNumber.optional(),
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
      accountRecheckCooldownSeconds: raw.ACCOUNT_RECHECK_COOLDOWN_SECONDS ?? 60,
      retention: {
        sessionsHours: raw.RETENTION_SESSIONS_HOURS ?? 24,
        usageDays: raw.RETENTION_USAGE_DAYS ?? 90,
        auditDays: raw.RETENTION_AUDIT_DAYS ?? 365,
        revokedKeysDays: raw.RETENTION_REVOKED_KEYS_DAYS ?? 30,
        oauthStateMinutes: raw.RETENTION_OAUTH_STATE_MINUTES ?? 10,
      },
      janitorIntervalMinutes: raw.JANITOR_INTERVAL_MINUTES ?? 60,
      adminAuth: {
        sessionIdleMinutes: raw.ADMIN_SESSION_IDLE_MINUTES ?? 480,
        sessionAbsoluteHours: raw.ADMIN_SESSION_ABSOLUTE_HOURS ?? 24,
        loginMaxAttempts: raw.ADMIN_LOGIN_MAX_ATTEMPTS ?? 5,
        loginAttemptWindowMinutes: raw.ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES ?? 15,
        loginLockoutMinutes: raw.ADMIN_LOGIN_LOCKOUT_MINUTES ?? 15,
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
