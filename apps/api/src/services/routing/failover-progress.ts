/**
 * The failover chain's progress folding and its in-place retries (a stale-session replay, the
 * overload and model-throttle waits), split from the planner (`failover.ts`) because they change for
 * a different reason: the planner decides *where* the next
 * attempt goes; these fold what an attempt said into the state it decides on. All pure.
 */

import {
  DEFAULT_MAX_IN_PLACE_RETRIES,
  type FailoverDecision,
  type FailoverOptions,
  type FailoverProgress,
  type FailoverStopReason,
} from "./failover"
import type { AttemptFailure, FailureKind } from "./failure-kind"
import type { Candidate } from "./types"

/**
 * Every account was asked and one said `overloaded`: the provider's shared backend is busy, which a
 * short wait fixes and another account does not. So that account is asked again after
 * `overloadRetryBaseMs`, doubling per retry, `overloadRetries` times — before any byte is on the
 * wire, as every retry here — unless its provider is in `gateRefusedProviders`: the router's own
 * full gate refused it this request, and a wait would meet the same gate. Then the chain stops and
 * the client hears `503` + `Retry-After` (`UpstreamOverloadedError`), not a router-made `429` for
 * the overload itself.
 */
export function waitOutOverload(
  ordered: readonly Candidate[],
  progress: FailoverProgress,
  lastFailure: AttemptFailure,
  options: FailoverOptions,
  exhausted: FailoverStopReason,
): FailoverDecision {
  const busyId =
    lastFailure.kind === "overloaded"
      ? progress.attemptedAccountIds[progress.attemptedAccountIds.length - 1]
      : progress.overloadedAccountId
  if (busyId === undefined) return waitOutThrottle(ordered, progress, options, exhausted)
  const cap = Math.max(0, Math.trunc(options.overloadRetries ?? 0))
  if (progress.overloadRetries >= cap) return { action: "stop", reason: exhausted }
  const candidate = ordered.find((entry) => entry.account.id === busyId)
  if (candidate === undefined) return { action: "stop", reason: exhausted }
  // A provider whose gate refused this request is not asked again after a pause either: the wait
  // would land on the very gate that just refused it. Only the gate set is read here: a provider
  // that refused the body for its own wire ({@link noteProviderScoped}) is still waited out when
  // it said `overloaded` earlier, as it was before the gate wait existed.
  if (progress.gateRefusedProviders?.includes(candidate.account.provider) === true)
    return { action: "stop", reason: exhausted }
  const base = Math.max(0, options.overloadRetryBaseMs ?? 0)
  return {
    action: "retry-in-place",
    candidate,
    attempt: progress.attemptedAccountIds.length,
    delayMs: base * 2 ** progress.overloadRetries,
  }
}

/**
 * A stale session is recovery in place, not a hop: the mapping is evicted and the request is
 * replayed once on the **same** account. The router never retries a `resume` against another one.
 */
export function replayInPlace(
  ordered: readonly Candidate[],
  progress: FailoverProgress,
  options: FailoverOptions,
): FailoverDecision {
  const cap = options.maxInPlaceRetries ?? DEFAULT_MAX_IN_PLACE_RETRIES
  if (progress.inPlaceRetries >= cap) return { action: "stop", reason: "not-retryable" }

  const lastId = progress.attemptedAccountIds[progress.attemptedAccountIds.length - 1]
  const candidate = ordered.find((entry) => entry.account.id === lastId)
  if (candidate === undefined) return { action: "stop", reason: "candidates-exhausted" }

  return { action: "retry-in-place", candidate, attempt: progress.attemptedAccountIds.length }
}

/**
 * The walk ran out and the account that last answered held the requested model off itself
 * ({@link noteModelThrottle}): no other candidate serves the name, and the hold is the router's own
 * pace for that (account, model), seconds long. So that account is asked again once the hold lapses
 * — before any byte is on the wire — while the waits fit `modelThrottleWaitMs`, one budget per
 * chain. A hold past what is left is not waited: the client hears the `429` and its `Retry-After`.
 * Prod 2026-11-28: a soft free-tier throttle answered a third of one model's requests `429`, and
 * each one reached the client in ~350 ms while a retry seconds later was likelier to serve.
 */
function waitOutThrottle(
  ordered: readonly Candidate[],
  progress: FailoverProgress,
  options: FailoverOptions,
  exhausted: FailoverStopReason,
): FailoverDecision {
  const throttled = progress.throttled
  if (throttled === undefined) return { action: "stop", reason: exhausted }
  const budget = Math.max(0, options.modelThrottleWaitMs ?? 0)
  if ((progress.throttleWaitedMs ?? 0) + throttled.delayMs > budget)
    return { action: "stop", reason: exhausted }
  const candidate = ordered.find((entry) => entry.account.id === throttled.accountId)
  if (candidate === undefined) return { action: "stop", reason: exhausted }
  return {
    action: "retry-in-place",
    candidate,
    attempt: progress.attemptedAccountIds.length,
    delayMs: throttled.delayMs,
    throttle: true,
  }
}

/**
 * Folds one failed attempt's model hold into the progress: `delayMs` is how long the hold it just
 * took (or extended) has to run, `null` when the attempt took none, which forgets an earlier one
 * from that same account. Pure; returns a new value.
 */
export function noteModelThrottle(
  progress: FailoverProgress,
  accountId: string,
  delayMs: number | null,
): FailoverProgress {
  if (delayMs !== null)
    return { ...progress, throttled: { accountId, delayMs: Math.max(0, delayMs) } }
  if (progress.throttled?.accountId !== accountId) return progress
  const { throttled: _forgotten, ...rest } = progress
  return rest
}

/**
 * Why an attempt went to the same account again: a session replay, a wait on a busy provider, or a
 * wait for a model hold to lapse.
 */
export type InPlaceReason = "replay" | "overload" | "throttle"

/**
 * Folds one dispatched attempt into the progress. Returns a new value; nothing mutates. `true` is a
 * replay, as it was before the in-place reasons had their own counters. A `throttle` retry spends
 * the hold it was planned on ({@link waitOutThrottle} waits exactly `throttled.delayMs`).
 */
export function recordAttempt(
  progress: FailoverProgress,
  accountId: string,
  inPlace: boolean | InPlaceReason = false,
): FailoverProgress {
  if (inPlace === false)
    return { ...progress, attemptedAccountIds: [...progress.attemptedAccountIds, accountId] }
  if (inPlace === "throttle") {
    const waited = (progress.throttleWaitedMs ?? 0) + (progress.throttled?.delayMs ?? 0)
    return { ...progress, throttleWaitedMs: waited }
  }
  return inPlace === "overload"
    ? { ...progress, overloadRetries: progress.overloadRetries + 1 }
    : { ...progress, inPlaceRetries: progress.inPlaceRetries + 1 }
}

/** The in-place reason a planned retry carries: a replay states no delay. */
export function inPlaceReason(decision: FailoverDecision): InPlaceReason | false {
  if (decision.action !== "retry-in-place") return false
  if (decision.throttle === true) return "throttle"
  return decision.delayMs === undefined ? "replay" : "overload"
}

/**
 * Folds one failed attempt's kind into the progress: `overloaded` names the account to wait out,
 * anything else from that same account forgets it. Pure; returns a new value.
 */
export function noteOverload(
  progress: FailoverProgress,
  accountId: string,
  kind: FailureKind,
): FailoverProgress {
  if (kind === "overloaded") return { ...progress, overloadedAccountId: accountId }
  if (progress.overloadedAccountId !== accountId) return progress
  const { overloadedAccountId: _forgotten, ...rest } = progress
  return rest
}

/**
 * Folds a `router-full` refusal into the progress: the replica's one global gate is full for the
 * whole request, so no further candidate that dispatches through it is offered. Records the provider
 * in {@link FailoverProgress.refusedProviders} (the planner skips its candidates: the Claude
 * subscription provider is the only one served by the Agent-SDK transport, so that refuses exactly
 * the candidates behind the gate, and an account of another kind is still tried) and in
 * {@link FailoverProgress.gateRefusedProviders}, the only set the overload wait reads. Pure; returns
 * a new value.
 */
export function noteGateFull(
  progress: FailoverProgress,
  provider: string,
  failure: Pick<AttemptFailure, "kind">,
): FailoverProgress {
  if (failure.kind !== "router-full") return progress
  const refused = noteProviderScoped(progress, provider, { providerScoped: true })
  const gated = refused.gateRefusedProviders ?? []
  if (gated.includes(provider)) return refused
  return { ...refused, gateRefusedProviders: [...gated, provider] }
}

/** Called the instant the first byte reaches the client. From here nothing may be retried. */
export function markStreamed(progress: FailoverProgress): FailoverProgress {
  return { ...progress, bytesStreamed: true }
}

/** Folds one failed attempt into the request-attributable count. Pure; returns a new value. */
export function noteRequestAttributable(
  progress: FailoverProgress,
  failure: Pick<AttemptFailure, "requestAttributable">,
): FailoverProgress {
  if (failure.requestAttributable !== true) return progress
  return { ...progress, requestAttributable: (progress.requestAttributable ?? 0) + 1 }
}

/**
 * Folds one failed attempt's provider into the progress when the refusal was about that vendor's
 * wire ({@link AttemptFailure.providerScoped}): the planner then offers none of its other accounts.
 * Pure; returns a new value. The planner reads only this, so a chain that skips the fold walks the
 * provider's remaining accounts into the same `4xx`.
 */
export function noteProviderScoped(
  progress: FailoverProgress,
  provider: string,
  failure: Pick<AttemptFailure, "providerScoped">,
): FailoverProgress {
  if (failure.providerScoped !== true) return progress
  const refused = progress.refusedProviders ?? []
  if (refused.includes(provider)) return progress
  return { ...progress, refusedProviders: [...refused, provider] }
}
