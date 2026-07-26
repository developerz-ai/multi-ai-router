/**
 * Tunables for the admin authentication plane — session lifetime and login throttling.
 *
 * CLAUDE.md rule 11: every retention window, interval, and limit is configuration, never a
 * constant in code. The operator-facing half lives in `config/env.ts` as five variables;
 * {@link adminAuthConfigFromEnv} is the only place that converts them into the seconds this
 * service works in, and {@link DEFAULT_ADMIN_AUTH_ENV} is the one copy of the defaults on this
 * side of that boundary. The factory still takes overrides so a test can compress a
 * fifteen-minute lockout into a millisecond without touching an environment.
 */

export interface AdminAuthConfig {
  /**
   * Sliding idle window. Every authenticated request pushes it forward, so an operator working
   * in the console is never logged out mid-task, while a walked-away-from browser stops being a
   * live credential within the window.
   */
  readonly idleTtlSeconds: number
  /**
   * Hard ceiling on a session's total life, regardless of activity. Sliding alone means a stolen
   * cookie can be renewed forever by the thief; the cap turns "forever" into a bounded window
   * and forces a re-auth on a known schedule. Nothing needs to enforce `absolute >= idle`: a
   * session dies at whichever bound comes first (`sessionExpiryMs`).
   */
  readonly absoluteTtlSeconds: number
  /** Failed logins tolerated per throttle key before the key locks. */
  readonly maxFailedAttempts: number
  /** Failures older than this stop counting — an operator's typo yesterday is not evidence. */
  readonly attemptWindowSeconds: number
  /** How long a key stays locked once it trips. */
  readonly lockoutSeconds: number
  /**
   * Share of `idleTtlSeconds` a session must have advanced since its last persisted
   * `lastSeenAtMs` before `authenticate` writes the slide back to the store. In-memory
   * `lastSeenAtMs` on the returned session is always current — only the store write is
   * throttled, so a Postgres-backed store isn't hit on every authenticated request.
   */
  readonly sessionSlideFraction: number
}

/**
 * The shape `config/env.ts` exposes, in the units its variables are named for. Structural rather
 * than a `Pick<Env, …>`: the full `Env` satisfies it, so boot passes `env` straight through, and
 * this module stays independent of every other setting.
 *
 * | Field | Variable |
 * |---|---|
 * | `adminSessionIdleMinutes` | `ADMIN_SESSION_IDLE_MINUTES` |
 * | `adminSessionAbsoluteHours` | `ADMIN_SESSION_ABSOLUTE_HOURS` |
 * | `adminLoginMaxAttempts` | `ADMIN_LOGIN_MAX_ATTEMPTS` |
 * | `adminLoginAttemptWindowMinutes` | `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES` |
 * | `adminLoginLockoutMinutes` | `ADMIN_LOGIN_LOCKOUT_MINUTES` |
 * | `adminSessionSlideFraction` | `ADMIN_SESSION_SLIDE_FRACTION` |
 */
export interface AdminAuthEnvConfig {
  readonly adminSessionIdleMinutes: number
  readonly adminSessionAbsoluteHours: number
  readonly adminLoginMaxAttempts: number
  readonly adminLoginAttemptWindowMinutes: number
  readonly adminLoginLockoutMinutes: number
  readonly adminSessionSlideFraction: number
}

/** The documented defaults — the values `config/env.ts` applies when a variable is unset. */
export const DEFAULT_ADMIN_AUTH_ENV: AdminAuthEnvConfig = {
  adminSessionIdleMinutes: 480,
  adminSessionAbsoluteHours: 24,
  adminLoginMaxAttempts: 5,
  adminLoginAttemptWindowMinutes: 15,
  adminLoginLockoutMinutes: 15,
  adminSessionSlideFraction: 0.1,
}

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

export function adminAuthConfigFromEnv(env: AdminAuthEnvConfig): AdminAuthConfig {
  return {
    idleTtlSeconds: env.adminSessionIdleMinutes * SECONDS_PER_MINUTE,
    absoluteTtlSeconds: env.adminSessionAbsoluteHours * SECONDS_PER_HOUR,
    maxFailedAttempts: env.adminLoginMaxAttempts,
    attemptWindowSeconds: env.adminLoginAttemptWindowMinutes * SECONDS_PER_MINUTE,
    lockoutSeconds: env.adminLoginLockoutMinutes * SECONDS_PER_MINUTE,
    sessionSlideFraction: env.adminSessionSlideFraction,
  }
}

/** Derived, so the defaults exist exactly once and cannot drift from the env-derived path. */
export const DEFAULT_ADMIN_AUTH_CONFIG: AdminAuthConfig =
  adminAuthConfigFromEnv(DEFAULT_ADMIN_AUTH_ENV)

export function resolveAdminAuthConfig(overrides: Partial<AdminAuthConfig> = {}): AdminAuthConfig {
  return { ...DEFAULT_ADMIN_AUTH_CONFIG, ...overrides }
}
