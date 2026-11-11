import type { AccountStatus, QuotaWindowState } from "@multi-ai-router/core"
import type { BreakerOptions } from "../routing"
import type { HealthObservation } from "./health-observation"

export interface HealthStoreOptions {
  /**
   * `MAX_REPORTED_RESET_SECONDS`: a provider-reported reset further out than this is bounded, on a
   * failure and on a limiter reading alike (04.2). Absent: no ceiling.
   */
  readonly maxReportedResetSeconds?: number
  /** `MODEL_REFUSAL_TTL_SECONDS` in ms: how long a `model-unsupported` answer keeps that upstream
   * model off the account (10.16). Absent: refusals are not remembered. */
  readonly modelRefusalTtlMs?: number
  readonly failureThreshold?: number
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly authFailureCooldownMs?: number
  readonly authFailureMaxCooldownMs?: number
  readonly jitter?: () => number
  readonly probeHoldMs?: number
  /** `LEAST_USED_TOKEN_WINDOW_SECONDS` in ms (02.10). Absent keeps the since-boot total. */
  readonly tokenWindowMs?: number
  /** Monotonic ms the token window rotates on; injected so a test drives it. */
  readonly elapsed?: () => number
  /**
   * How old a plan reading may be and still lend its reset to a reset-less limit refusal
   * (`routing/plan-reset.ts`). Absent: no reading lends, the breaker's own backoff stands.
   */
  readonly planReadingMaxAgeMs?: number
  readonly onQuotaWindows?: (
    accountId: string,
    windows: readonly QuotaWindowState[],
    observation?: HealthObservation,
  ) => void
  readonly onBlocked?: (
    accountId: string,
    status: AccountStatus,
    observation?: HealthObservation,
    quotaWindows?: readonly QuotaWindowState[],
  ) => void
  readonly onReset?: (accountId: string) => void
}

/** The breaker options the store's own configuration fixes, before a caller's per-call overrides. */
export function configuredBreaker(options: HealthStoreOptions): BreakerOptions {
  return {
    ...(options.failureThreshold === undefined
      ? {}
      : { failureThreshold: options.failureThreshold }),
    ...(options.baseBackoffMs === undefined ? {} : { baseBackoffMs: options.baseBackoffMs }),
    ...(options.maxBackoffMs === undefined ? {} : { maxBackoffMs: options.maxBackoffMs }),
    ...(options.authFailureCooldownMs === undefined
      ? {}
      : { authFailureCooldownMs: options.authFailureCooldownMs }),
    ...(options.authFailureMaxCooldownMs === undefined
      ? {}
      : { authFailureMaxCooldownMs: options.authFailureMaxCooldownMs }),
    ...(options.maxReportedResetSeconds === undefined
      ? {}
      : { maxReportedResetSeconds: options.maxReportedResetSeconds }),
  }
}
