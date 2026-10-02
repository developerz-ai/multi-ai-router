/**
 * The cooldown a refused API key sits in — labeled `credential-rejected`, re-tested by one probe.
 *
 * Split from `breaker.ts` because it answers its own question: the breaker decides *which* state a
 * failure lands in, this owns how one of them behaves once it is there. The rule it exists to keep:
 *
 * **One refusal is one incident, and only the re-test moves it.** A key is refused once and the
 * refusal arrives as many responses — every request in flight when the first landed comes back
 * too, most refused, some answered `5xx` or `429` by whatever sits in front of the provider. While
 * the labeled cooldown is still running ({@link refusalStands}) none of them changes the refusal
 * count or the instant the re-test is due. The half-open probe is the next thing that does.
 */

import { backoffMs, reportedReset } from "./backoff"
import type { BreakerOptions, BreakerState } from "./breaker"
import type { AttemptFailure } from "./failover"

/**
 * {@link BreakerOptions.authFailureCooldownMs}. Long enough that a key the provider genuinely
 * revoked costs one failed request per interval, short enough that a misread limit — or a key an
 * operator fixed at the provider without touching the router — is back within minutes.
 */
export const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 15 * 60_000

/**
 * {@link BreakerOptions.authFailureMaxCooldownMs}. A key refused again and again is almost certainly
 * revoked, so each refused re-test doubles the wait — 15, 30, 60, 120 minutes — but never past this:
 * a key an operator fixes at the provider without touching the router is still found within hours,
 * not days. The operator's "Re-check now" is the immediate path.
 */
export const DEFAULT_AUTH_FAILURE_MAX_COOLDOWN_MS = 4 * 60 * 60_000

/**
 * The refusal is still the account's standing verdict: labeled, and its cooldown not yet passed.
 * This is the breaker's `open` phase for a labeled state, restated rather than imported because
 * this module sits beneath `breaker.ts` — a labeled state always carries its instant.
 */
export function refusalStands(state: BreakerState, now: Date): boolean {
  if (state.cooldownReason !== "credential-rejected") return false
  return state.cooldownUntil !== undefined && state.cooldownUntil.getTime() > now.getTime()
}

/**
 * The provider refused this account's key: out for a while, labeled, then re-tested by one probe.
 *
 * The wait is {@link backoffMs} over the refusal streak: the auth cooldown as base, the auth cap as
 * ceiling, the same jitter as every other step so keys refused together are not re-tested together.
 * The streak is `consecutiveFailures`, counted only while the state already carries the label —
 * server errors before the first refusal do not lengthen it, and a success starts it over.
 *
 * **Only a re-test escalates.** Counting each refused response put a key on the four-hour cap the
 * first time it was ever refused. A refusal while the last one {@link refusalStands} is that same
 * refusal: count and instant stand. The probe (`half-open`) is the next. `estimated`: the length is
 * ours.
 */
export function rejectCredential(
  state: BreakerState,
  now: Date,
  options: BreakerOptions,
): BreakerState {
  if (refusalStands(state, now)) return state
  const base = options.authFailureCooldownMs ?? DEFAULT_AUTH_FAILURE_COOLDOWN_MS
  // A cap below the base would make the first step the longest; the base wins.
  const cap = Math.max(
    base,
    options.authFailureMaxCooldownMs ?? DEFAULT_AUTH_FAILURE_MAX_COOLDOWN_MS,
  )
  const labeled = state.cooldownReason === "credential-rejected"
  const refusals = (labeled ? state.consecutiveFailures : 0) + 1
  const waitMs = backoffMs(refusals, {
    baseBackoffMs: base,
    maxBackoffMs: cap,
    jitter: options.jitter ?? 0,
  })
  const until = new Date(now.getTime() + waitMs)
  const existing = state.status === "cooling_down" ? state.cooldownUntil : undefined
  const longer = existing !== undefined && existing.getTime() >= until.getTime()
  return {
    status: "cooling_down",
    cooldownUntil: longer ? existing : until,
    cooldownSource: longer ? state.cooldownSource : "estimated",
    cooldownReason: "credential-rejected",
    consecutiveFailures: refusals,
  }
}

/**
 * A limiter *reading* folded in while the refusal stands (`dataplane/health-reading.ts`). It says
 * when a limiter refills and nothing about the key, so it is not a sibling verdict and not a
 * re-test: it may push the re-test out to the reset the provider named — a longer reset is never
 * un-learned — and it moves neither the label nor the count. A reading that names no reset moves
 * nothing at all: our own backoff arithmetic is no reason to hold a refused key out for longer.
 */
export function lengthenRefusal(
  state: BreakerState,
  reading: Pick<AttemptFailure, "resetsAt" | "retryAfterSeconds" | "resetSource">,
  now: Date,
): BreakerState {
  const reset = reportedReset(reading, now)
  const standing = state.cooldownUntil
  if (reset === null || standing === undefined) return state
  if (standing.getTime() >= reset.getTime()) return state
  return {
    ...state,
    cooldownUntil: reset,
    cooldownSource: reading.resetSource ?? "provider-reported",
  }
}
