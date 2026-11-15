import {
  type AttemptFailure,
  type BreakerOptions,
  HEALTHY,
  type ModelRefusal,
  recordFailure,
} from "../routing"
import type { AccountHealthState } from "./health"

/**
 * The per-(account, model) holds the health store keeps in `refusedModels` — pure, split from the
 * store by responsibility. Expired holds are dropped on every write, so the map is bounded by the
 * models an account is refusing *now*.
 */

/** The provider said it does not serve the name: held for `ttlMs` (10.16). */
export function refuseHeld(
  state: AccountHealthState,
  upstreamModel: string,
  now: Date,
  ttlMs: number,
): Map<string, ModelRefusal> {
  const kept = liveRefusals(state, now)
  kept.set(upstreamModel, { until: new Date(now.getTime() + ttlMs), reason: "unsupported" })
  return kept
}

/**
 * A throttle on this model alone, run through the breaker's own transition on a model-sized state:
 * one reported-reset rule, one ceiling, one backoff schedule — stepped by the strikes this model has
 * drawn while its hold stood. The account's own breaker is never touched.
 */
export function throttleHeld(
  state: AccountHealthState,
  upstreamModel: string,
  failure: AttemptFailure,
  now: Date,
  options: BreakerOptions,
): Map<string, ModelRefusal> {
  const kept = liveRefusals(state, now)
  const prior = kept.get(upstreamModel)
  const strikes = prior?.reason === "rate-limited" ? (prior.strikes ?? 0) : 0
  const tripped = recordFailure(
    { ...HEALTHY, consecutiveFailures: strikes },
    { ...failure, kind: "rate-limited" },
    now,
    options,
  )
  if (tripped.cooldownUntil === undefined) return kept
  kept.set(upstreamModel, {
    until: tripped.cooldownUntil,
    reason: "rate-limited",
    ...(tripped.cooldownSource === undefined ? {} : { resetSource: tripped.cooldownSource }),
    strikes: tripped.consecutiveFailures,
  })
  return kept
}

function liveRefusals(state: AccountHealthState, now: Date): Map<string, ModelRefusal> {
  return new Map([...(state.refusedModels ?? [])].filter(([, held]) => held.until > now))
}
