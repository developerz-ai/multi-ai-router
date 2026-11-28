import {
  type AttemptFailure,
  type BreakerOptions,
  DEFAULT_MAX_BACKOFF_MS,
  HEALTHY,
  type ModelRefusal,
  recordFailure,
} from "../routing"
import type { AccountHealthState, HealthStore } from "./health"
import type { HealthStoreOptions } from "./health-options"

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

/** Successes in a row on a throttled model that step its hold down one strike (`modelServed`). */
export const DEFAULT_MODEL_THROTTLE_SUCCESSES_PER_STEP = 3

/**
 * A throttle on this model alone, run through the breaker's own transition on a model-sized state:
 * one reported-reset rule, one ceiling, one backoff schedule — stepped by the strikes this model has
 * drawn. The account's own breaker is never touched.
 *
 * The strikes outlive the hold. A free tier that throttles softly answers `429` to a share of
 * requests and `200` to the rest, so its `429`s arrive seconds after the last hold lapsed; through
 * 2.82.1 a lapsed hold was dropped with its strikes and every `429` restarted the backoff at its
 * first step, which paced nothing (prod 2026-11-28, 36% of one NVIDIA key's requests). A strike is
 * now forgotten only by a run of successes ({@link servedHeld}) or a whole `maxBackoffMs` span with
 * no `429`; the hold length is what the model is paced to.
 */
export function throttleHeld(
  state: AccountHealthState,
  upstreamModel: string,
  failure: AttemptFailure,
  now: Date,
  options: BreakerOptions,
): Map<string, ModelRefusal> {
  const kept = liveRefusals(state, now, options)
  const prior = kept.get(upstreamModel)
  const strikes = prior?.reason === "rate-limited" ? (prior.strikes ?? 0) : 0
  const tripped = recordFailure(
    { ...HEALTHY, consecutiveFailures: strikes },
    { ...failure, kind: "rate-limited" },
    now,
    options,
  )
  if (tripped.cooldownUntil === undefined) return kept
  // A hold still standing is never shortened by a later, shorter one (the breaker's own rule).
  const until =
    prior !== undefined && prior.until.getTime() > tripped.cooldownUntil.getTime()
      ? prior.until
      : tripped.cooldownUntil
  kept.set(upstreamModel, {
    until,
    reason: "rate-limited",
    ...(tripped.cooldownSource === undefined ? {} : { resetSource: tripped.cooldownSource }),
    strikes: tripped.consecutiveFailures,
  })
  return kept
}

/**
 * The model served on this account: one more success in the run, and a full run of
 * `successesPerStep` steps the hold down one strike. A standing hold keeps its instant (a response
 * already in flight when the `429` landed says nothing about the next one). `null`: nothing to change.
 */
export function servedHeld(
  state: AccountHealthState,
  upstreamModel: string,
  now: Date,
  options: BreakerOptions,
  successesPerStep = DEFAULT_MODEL_THROTTLE_SUCCESSES_PER_STEP,
): Map<string, ModelRefusal> | null {
  const prior = state.refusedModels?.get(upstreamModel)
  if (prior === undefined || prior.reason !== "rate-limited") return null
  const kept = liveRefusals(state, now, options)
  if (!kept.has(upstreamModel)) return kept
  const served = (prior.served ?? 0) + 1
  if (served < successesPerStep) {
    kept.set(upstreamModel, { ...prior, served })
    return kept
  }
  const strikes = Math.max(0, (prior.strikes ?? 0) - 1)
  if (strikes === 0 && prior.until.getTime() <= now.getTime()) {
    kept.delete(upstreamModel)
    return kept
  }
  const { served: _run, ...rest } = prior
  kept.set(upstreamModel, { ...rest, strikes })
  return kept
}

/**
 * The holds worth keeping: a refusal until it lapses, a throttle's strikes for one `maxBackoffMs`
 * span past its hold — the longest hold the schedule issues — so the map stays bounded by the models
 * an account refused or throttled recently.
 */
function liveRefusals(
  state: AccountHealthState,
  now: Date,
  options: BreakerOptions = {},
): Map<string, ModelRefusal> {
  const memoryMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  return new Map(
    [...(state.refusedModels ?? [])].filter(([, held]) =>
      held.reason === "rate-limited"
        ? held.until.getTime() + memoryMs > now.getTime()
        : held.until > now,
    ),
  )
}

/** The health store's per-model methods, over its own state accessors. */
export function modelHoldMethods(
  read: (accountId: string) => AccountHealthState,
  write: (accountId: string, patch: Partial<AccountHealthState>) => void,
  options: HealthStoreOptions,
  configured: BreakerOptions,
  breakerOptions: (caller?: BreakerOptions) => BreakerOptions,
): Pick<HealthStore, "refuseModel" | "throttleModel" | "modelServed"> {
  return {
    refuseModel(accountId, upstreamModel, now) {
      const ttlMs = options.modelRefusalTtlMs
      if (ttlMs === undefined) return
      write(accountId, { refusedModels: refuseHeld(read(accountId), upstreamModel, now, ttlMs) })
    },
    throttleModel(accountId, upstreamModel, failure, now, caller) {
      const state = read(accountId)
      write(accountId, {
        refusedModels: throttleHeld(state, upstreamModel, failure, now, breakerOptions(caller)),
      })
    },
    modelServed(accountId, upstreamModel, now) {
      const perStep = options.modelThrottleSuccessesPerStep
      const held = servedHeld(read(accountId), upstreamModel, now, configured, perStep)
      if (held !== null) write(accountId, { refusedModels: held })
    },
  }
}
