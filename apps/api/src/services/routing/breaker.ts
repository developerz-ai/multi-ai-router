/**
 * The circuit breaker, as pure state transitions over an injected clock.
 *
 * | State | Meaning | Exit |
 * |---|---|---|
 * | `active` | Eligible for selection. | — |
 * | `cooling_down` | Excluded. **Temporary — a clock will fix it.** | Reset instant passes, then a half-open probe. |
 * | half-open | One request through as a probe. | Success -> `active`. Failure -> `cooling_down` at the next backoff step. |
 * | `exhausted` | Excluded. **Permanent until a human acts.** The breaker never schedules a retry. | An operator tops up, then a re-check or a successful probe. |
 *
 * `cooling_down` and `exhausted` are never conflated, and the difference is mechanical rather
 * than cosmetic: `exhausted` carries **no** `cooldownUntil`, so no amount of clock advance moves
 * it. {@link phase} returns `blocked` for it forever. That is the invariant the tests pin.
 *
 * Backoff prefers the provider-reported reset — it is the truth. Exponential backoff is the
 * fallback for when nothing was reported, and it is labeled `unknown` rather than dressed up as
 * a fact. Jitter is a caller-supplied fraction, so this module reads no randomness either.
 */

import type { AccountStatus, AuthKind, ResetSource } from "@multi-ai-router/core"
import type { AttemptFailure } from "./failover"

export interface BreakerState {
  readonly status: AccountStatus
  /** Absent on `active`, and absent on `exhausted` **by definition**. */
  readonly cooldownUntil?: Date
  readonly cooldownSource: ResetSource
  readonly consecutiveFailures: number
}

export const HEALTHY: BreakerState = {
  status: "active",
  cooldownSource: "unknown",
  consecutiveFailures: 0,
}

export interface BreakerOptions {
  /** First backoff step. Doubles per consecutive failure. */
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Consecutive 5xx / connection failures before the breaker trips. */
  readonly failureThreshold?: number
  /** Jitter fraction in `[0, 1)`, supplied by the caller. 0 keeps the math deterministic. */
  readonly jitter?: number
  /** Decides where an auth failure lands: `api-key` -> `disabled`, `oauth` -> `needs_reauth`. */
  readonly authKind?: AuthKind
}

export const DEFAULT_BASE_BACKOFF_MS = 1_000
export const DEFAULT_MAX_BACKOFF_MS = 300_000
export const DEFAULT_FAILURE_THRESHOLD = 3
/** Jitter widens a step by at most this fraction, never shortens it. */
export const JITTER_FRACTION = 0.2

export type BreakerPhase =
  /** Eligible. */
  | "closed"
  /** Cooling down, reset still ahead. */
  | "open"
  /** Reset passed: one probe may go through. */
  | "half-open"
  /** No timer will change this. Only an operator. */
  | "blocked"

export function phase(state: BreakerState, now: Date): BreakerPhase {
  if (state.status === "exhausted" || state.status === "needs_reauth") return "blocked"
  if (state.status === "disabled") return "blocked"
  if (state.status !== "cooling_down") return "closed"
  if (state.cooldownUntil === undefined) return "open"
  return state.cooldownUntil.getTime() > now.getTime() ? "open" : "half-open"
}

export function recordFailure(
  state: BreakerState,
  failure: AttemptFailure,
  now: Date,
  options: BreakerOptions = {},
): BreakerState {
  switch (failure.kind) {
    // A bad request is bad at every account: it says nothing about this one's health.
    case "client-error":
    case "stale-session":
      return state

    // No clock refills a drained balance. No reset instant is recorded, deliberately.
    case "credits-exhausted":
      return {
        status: "exhausted",
        cooldownSource: "unknown",
        consecutiveFailures: state.consecutiveFailures + 1,
      }

    case "auth":
      return {
        status: options.authKind === "api-key" ? "disabled" : "needs_reauth",
        cooldownSource: "unknown",
        consecutiveFailures: state.consecutiveFailures + 1,
      }

    case "rate-limited":
      return trip(state, failure, now, options, state.consecutiveFailures + 1)

    default: {
      const failures = state.consecutiveFailures + 1
      if (failures < (options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)) {
        return { ...state, consecutiveFailures: failures }
      }
      return trip(state, failure, now, options, failures)
    }
  }
}

/**
 * The first success resets the streak and returns the account to `active` — including from
 * `exhausted`, because the only request that can reach an `exhausted` account is the operator's
 * "Re-check now" probe, which is the same code path as the half-open probe. Nothing here
 * *schedules* that; it is human action, exactly as the state machine requires.
 */
export function recordSuccess(): BreakerState {
  return HEALTHY
}

export function backoffMs(consecutiveFailures: number, options: BreakerOptions = {}): number {
  const base = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
  const cap = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const steps = Math.max(0, consecutiveFailures - 1)
  const capped = Math.min(base * 2 ** steps, cap)
  const jitter = clampJitter(options.jitter ?? 0)
  return Math.round(capped * (1 + JITTER_FRACTION * jitter))
}

function trip(
  state: BreakerState,
  failure: AttemptFailure,
  now: Date,
  options: BreakerOptions,
  failures: number,
): BreakerState {
  const reported = reportedReset(failure, now)
  const until = reported ?? new Date(now.getTime() + backoffMs(failures, options))
  // `estimated`, not `unknown`: when the provider reported nothing we still computed an instant
  // from the backoff schedule, and that is precisely what "estimated" means. Calling it unknown
  // would understate what we know, and the console renders this qualifier next to the countdown —
  // an operator has to be able to tell a provider's own reset from our arithmetic.
  const source: ResetSource =
    reported === null ? "estimated" : (failure.resetSource ?? "provider-reported")

  // A later mark may extend an entry; an earlier one never shortens it, so two concurrent
  // failures cannot un-learn the longer reset.
  const existing = state.status === "cooling_down" ? state.cooldownUntil : undefined
  if (existing !== undefined && existing.getTime() >= until.getTime()) {
    return {
      status: "cooling_down",
      cooldownUntil: existing,
      cooldownSource: state.cooldownSource,
      consecutiveFailures: failures,
    }
  }

  return {
    status: "cooling_down",
    cooldownUntil: until,
    cooldownSource: source,
    consecutiveFailures: failures,
  }
}

function reportedReset(failure: AttemptFailure, now: Date): Date | null {
  if (failure.resetsAt !== undefined) return failure.resetsAt
  if (failure.retryAfterSeconds !== undefined) {
    return new Date(now.getTime() + failure.retryAfterSeconds * 1000)
  }
  return null
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}
