/**
 * How long a cooldown lasts: the provider's own reset when it reported one, the exponential
 * schedule when it did not. Pure — the clock and the jitter fraction are the caller's.
 *
 * A leaf beneath `breaker.ts` and `credential-rejection.ts`, which both step through it.
 */

import { latestResetDeadline, type ResetSource } from "@multi-ai-router/core"
import type { BreakerOptions } from "./breaker"
import type { AttemptFailure } from "./failure-kind"

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

/**
 * Ceiling on any provider-reported reset (`ROUTING_MAX_REPORTED_RESET_SECONDS`): eight days, since
 * the longest documented provider window is weekly. Past it, a reset is a misread or a body stamp
 * nobody can bound, not a window — a ten-year `Retry-After` must not park an account for ten years.
 */
export const DEFAULT_MAX_REPORTED_RESET_SECONDS = 691_200

export interface ReportedReset {
  readonly at: Date
  /** The provider's instant lay past the ceiling, so `at` is the ceiling: our bound, not theirs. */
  readonly clamped: boolean
}

/** The instant the provider said the limit lifts, bounded by the ceiling; `null` when it named none. */
export function boundedReportedReset(
  failure: Pick<AttemptFailure, "resetsAt" | "retryAfterSeconds">,
  now: Date,
  maxReportedResetSeconds: number = DEFAULT_MAX_REPORTED_RESET_SECONDS,
): ReportedReset | null {
  const reported = latestResetDeadline(failure, now)
  if (reported === null) return null
  const ceiling = now.getTime() + maxReportedResetSeconds * 1_000
  return reported.getTime() > ceiling
    ? { at: new Date(ceiling), clamped: true }
    : { at: reported, clamped: false }
}

/** {@link boundedReportedReset}'s instant alone. */
export function reportedReset(
  failure: Pick<AttemptFailure, "resetsAt" | "retryAfterSeconds">,
  now: Date,
  maxReportedResetSeconds?: number,
): Date | null {
  return boundedReportedReset(failure, now, maxReportedResetSeconds)?.at ?? null
}

/** How a reported reset is labeled: a clamped one is our ceiling, so `estimated`. */
export function reportedResetSource(
  reset: ReportedReset,
  stated: ResetSource | undefined,
): ResetSource {
  return reset.clamped ? "estimated" : (stated ?? "provider-reported")
}

function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}
