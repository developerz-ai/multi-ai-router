/**
 * The failover chain's progress folding and its overload wait, split from the planner
 * (`failover.ts`) because they change for a different reason: the planner decides *where* the next
 * attempt goes; these fold what an attempt said into the state it decides on. All pure.
 */

import type {
  FailoverDecision,
  FailoverOptions,
  FailoverProgress,
  FailoverStopReason,
} from "./failover"
import type { AttemptFailure, FailureKind } from "./failure-kind"
import type { Candidate } from "./types"

/**
 * Every account was asked and one said `overloaded`: the provider's shared backend is busy, which a
 * short wait fixes and another account does not. So that account is asked again after
 * `overloadRetryBaseMs`, doubling per retry, `overloadRetries` times — before any byte is on the
 * wire, as every retry here. Then the chain stops and the client hears `503` + `Retry-After`
 * (`UpstreamOverloadedError`), never a router-made `429`.
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
  if (busyId === undefined) return { action: "stop", reason: exhausted }
  const cap = Math.max(0, Math.trunc(options.overloadRetries ?? 0))
  if (progress.overloadRetries >= cap) return { action: "stop", reason: exhausted }
  const candidate = ordered.find((entry) => entry.account.id === busyId)
  if (candidate === undefined) return { action: "stop", reason: exhausted }
  const base = Math.max(0, options.overloadRetryBaseMs ?? 0)
  return {
    action: "retry-in-place",
    candidate,
    attempt: progress.attemptedAccountIds.length,
    delayMs: base * 2 ** progress.overloadRetries,
  }
}

/** Why an attempt went to the same account again: a session replay, or a wait on a busy provider. */
export type InPlaceReason = "replay" | "overload"

/**
 * Folds one dispatched attempt into the progress. Returns a new value; nothing mutates. `true` is a
 * replay, as it was before the two in-place reasons had their own counters.
 */
export function recordAttempt(
  progress: FailoverProgress,
  accountId: string,
  inPlace: boolean | InPlaceReason = false,
): FailoverProgress {
  if (inPlace === false)
    return { ...progress, attemptedAccountIds: [...progress.attemptedAccountIds, accountId] }
  return inPlace === "overload"
    ? { ...progress, overloadRetries: progress.overloadRetries + 1 }
    : { ...progress, inPlaceRetries: progress.inPlaceRetries + 1 }
}

/** The in-place reason a planned retry carries: only an overload wait states a delay. */
export function inPlaceReason(decision: FailoverDecision): InPlaceReason | false {
  if (decision.action !== "retry-in-place") return false
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
