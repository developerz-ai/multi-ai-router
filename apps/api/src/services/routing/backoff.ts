/**
 * How long a cooldown lasts: the provider's own reset when it reported one, the exponential
 * schedule when it did not. Pure — the clock and the jitter fraction are the caller's.
 *
 * A leaf beneath `breaker.ts` and `credential-rejection.ts`, which both step through it.
 */

import type { BreakerOptions } from "./breaker"
import type { AttemptFailure } from "./failover"

export const DEFAULT_BASE_BACKOFF_MS = 1_000
export const DEFAULT_MAX_BACKOFF_MS = 300_000
/** Jitter widens a step by at most this fraction, never shortens it. */
export const JITTER_FRACTION = 0.2

export function backoffMs(consecutiveFailures: number, options: BreakerOptions = {}): number {
  const base = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
  const cap = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const steps = Math.max(0, consecutiveFailures - 1)
  const capped = Math.min(base * 2 ** steps, cap)
  const jitter = clampJitter(options.jitter ?? 0)
  return Math.round(capped * (1 + JITTER_FRACTION * jitter))
}

/** The instant the provider said the limit lifts, or `null` when it named none. */
export function reportedReset(
  failure: Pick<AttemptFailure, "resetsAt" | "retryAfterSeconds">,
  now: Date,
): Date | null {
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
