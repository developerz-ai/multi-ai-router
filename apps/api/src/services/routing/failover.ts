/**
 * Step 5's decision half: what a failed attempt means and where the next one goes. The dispatch
 * itself is I/O and lives above this module; everything here is pure.
 *
 * | Condition | Action |
 * |---|---|
 * | `429` | Retry the next candidate; the account cools down until its reset. |
 * | `402` / out-of-credits body | Retry the next candidate; the account becomes `exhausted`. |
 * | `5xx`, connection failure, timeout | Retry the next candidate; counts toward the failure streak. |
 * | other `4xx` | **Do not retry.** A bad request is bad at every account. |
 * | model not served (driver-classified) | Retry the next candidate. No breaker strike: the account answered, about a name it never served. |
 * | `401` / `403` | Retry the next candidate. The account is parked `needs_reauth`, where a refreshable credential earns one off-path refresh, or cools `credential-rejected`; a rejected credential is *this account's* problem, not the request's. |
 *
 * Three rules dominate the table:
 *
 * - **Once bytes have been streamed to the client, nothing is retried.** Replaying a partially
 *   delivered stream produces a response the client cannot reconcile — duplicated tokens, a
 *   second `message_start`, a tool call emitted twice. Hard rule, not a tunable.
 * - **Attempts are bounded by the pool**: the chain walks to the next account, and the next, until
 *   one serves or every eligible account has been tried. An operator who wants to fail sooner than
 *   that sets `ROUTING_MAX_ATTEMPTS`; nothing raises the bound past the candidates that exist.
 * - **Each attempt is a distinct account.** Never retry the same account inside one request —
 *   except the one in-place replay a stale SDK session earns, which is recovery on the *same*
 *   account and explicitly not a failover.
 */

import { waitOutOverload } from "./failover-progress"
import { type AttemptFailure, isRetryable } from "./failure-kind"
import type { Candidate } from "./types"

/** A stale SDK session earns exactly one replay in place. */
export const DEFAULT_MAX_IN_PLACE_RETRIES = 1

export interface FailoverOptions {
  /**
   * Operator ceiling on distinct accounts tried for one request. Absent means the pool itself is
   * the ceiling — see {@link maxAttempts}.
   */
  readonly maxAttempts?: number
  readonly maxInPlaceRetries?: number
  /**
   * `ROUTING_OVERLOAD_RETRIES`: once every candidate answered `overloaded`, how many more times the
   * last one is asked, each after a doubling wait. Absent or `0`: none.
   */
  readonly overloadRetries?: number
  /** `ROUTING_OVERLOAD_RETRY_BASE_MS`: the first of those waits. */
  readonly overloadRetryBaseMs?: number
  /** The account this session is bound to, when it has a binding. */
  readonly boundAccountId?: string
  /** Request-attributable refusals in one chain that end it as a request wall. Default 2. */
  readonly requestWallAfter?: number
}

/**
 * Two accounts refusing the same request for the request's own content is the request's fault:
 * walking the rest of the pool would only spend more turns on the same refusal.
 */
export const REQUEST_WALL_AFTER = 2

export interface FailoverProgress {
  /** In attempt order. Its length is the attempt count that lands in the `UsageRecord`. */
  readonly attemptedAccountIds: readonly string[]
  /** Stale-session replays on the same account ({@link replayInPlace}). */
  readonly inPlaceRetries: number
  /**
   * Waits on a busy provider ({@link waitOutOverload}). Its own budget: a replay earlier in the
   * request must not spend `ROUTING_OVERLOAD_RETRIES`, nor an overload wait the replay.
   */
  readonly overloadRetries: number
  /** Set the instant the first byte reaches the client. Never unset. */
  readonly bytesStreamed: boolean
  /**
   * The account that last answered `overloaded` and has answered nothing else since
   * ({@link noteOverload}). Once the walk runs out it is the one waited out, whatever the last
   * account said: a later seat's own limit must not decide whether a busy one is asked again.
   */
  readonly overloadedAccountId?: string
  /** Request-attributable refusals so far ({@link noteRequestAttributable}). Absent: none. */
  readonly requestAttributable?: number
}

export const NO_ATTEMPTS: FailoverProgress = {
  attemptedAccountIds: [],
  inPlaceRetries: 0,
  overloadRetries: 0,
  bytesStreamed: false,
}

export type FailoverStopReason =
  | "bytes-streamed"
  | "not-retryable"
  | "attempts-exhausted"
  | "candidates-exhausted"
  /** The request itself is refused wherever it goes ({@link AttemptFailure.requestAttributable}). */
  | "request-wall"

export type FailoverDecision =
  | {
      readonly action: "attempt"
      readonly candidate: Candidate
      /** 1-based position in the failover chain. */
      readonly attempt: number
      /** The chain is leaving the bound account; the attempt carries the session or restarts it. */
      readonly invalidateBinding: boolean
      /**
       * Client-visible truth on the SDK path: a fresh upstream session starts and prior turns
       * are gone. Surfaced, never hidden behind a truncated context or a flattened replay.
       */
      readonly sessionRestart: boolean
    }
  | {
      readonly action: "retry-in-place"
      readonly candidate: Candidate
      readonly attempt: number
      /** Wait this long before sending: set only on an `overloaded` retry. */
      readonly delayMs?: number
    }
  | { readonly action: "stop"; readonly reason: FailoverStopReason }

export function planNextAttempt(
  ordered: readonly Candidate[],
  progress: FailoverProgress,
  lastFailure: AttemptFailure | null,
  options: FailoverOptions = {},
): FailoverDecision {
  if (lastFailure === null) return firstAttempt(ordered, progress)

  // The streaming rule dominates everything below it, on both paths.
  if (progress.bytesStreamed) return { action: "stop", reason: "bytes-streamed" }

  if (lastFailure.kind === "stale-session") return replayInPlace(ordered, progress, options)
  if (!isRetryable(lastFailure.kind)) return { action: "stop", reason: "not-retryable" }
  if (
    lastFailure.requestAttributable === true &&
    (progress.requestAttributable ?? 0) >= (options.requestWallAfter ?? REQUEST_WALL_AFTER)
  )
    return { action: "stop", reason: "request-wall" }
  if (
    progress.attemptedAccountIds.length >= attemptCeiling(plannedCount(ordered, progress), options)
  ) {
    return waitOutOverload(ordered, progress, lastFailure, options, "attempts-exhausted")
  }

  const attempted = new Set(progress.attemptedAccountIds)
  const next = ordered.find((candidate) => !attempted.has(candidate.account.id))
  if (next === undefined) {
    return waitOutOverload(ordered, progress, lastFailure, options, "candidates-exhausted")
  }

  return attemptOn(next, ordered, progress, options)
}

/**
 * How many distinct accounts one request may be tried on: **every eligible one**, unless an
 * operator set a lower ceiling.
 *
 * There is deliberately no default number here any more. A fixed cap of three meant a pool of six
 * subscriptions stopped after two failures with four healthy accounts unasked — the client got an
 * honest-sounding error about capacity that was simply untrue, and the request the operator paid
 * for a deep pool to survive failed anyway. The pool *is* the bound: each attempt is a distinct
 * account (`planNextAttempt` never re-offers one), the candidate list is already filtered to
 * accounts that could serve, and the attempt deadline still governs the whole chain — so the walk
 * terminates in at most `ordered.length` attempts however large the pool grows.
 *
 * `ROUTING_MAX_ATTEMPTS` remains for the operator who wants to fail faster than their pool allows;
 * it can only ever lower this, never raise it past the candidates that exist.
 */
export function maxAttempts(ordered: readonly Candidate[], options: FailoverOptions = {}): number {
  return attemptCeiling(ordered.length, options)
}

function attemptCeiling(planned: number, options: FailoverOptions): number {
  if (options.maxAttempts === undefined) return planned
  const configured = Math.max(1, Math.trunc(options.maxAttempts))
  return Math.min(configured, planned)
}

/**
 * How many candidates this request was planned with: those still offered plus those already tried.
 * The chain drops a designated recovery probe that failed from `ordered` while its attempt stays
 * counted, so bounding on `ordered` alone stopped the walk one healthy account short per dropped
 * probe. An unattempted candidate the chain dropped (a refused probe) is in neither, which is right:
 * it will not be tried.
 */
function plannedCount(ordered: readonly Candidate[], progress: FailoverProgress): number {
  const offered = new Set(ordered.map((candidate) => candidate.account.id))
  const dropped = new Set(progress.attemptedAccountIds.filter((id) => !offered.has(id)))
  return ordered.length + dropped.size
}

function firstAttempt(ordered: readonly Candidate[], progress: FailoverProgress): FailoverDecision {
  const head = ordered[0]
  if (head === undefined) return { action: "stop", reason: "candidates-exhausted" }
  return {
    action: "attempt",
    candidate: head,
    attempt: progress.attemptedAccountIds.length + 1,
    invalidateBinding: false,
    sessionRestart: false,
  }
}

/**
 * A stale session is recovery in place, not a hop: the mapping is evicted and the request is
 * replayed once on the **same** account. The router never retries a `resume` against another one.
 */
function replayInPlace(
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

function attemptOn(
  next: Candidate,
  ordered: readonly Candidate[],
  progress: FailoverProgress,
  options: FailoverOptions,
): FailoverDecision {
  const boundId = options.boundAccountId
  const leavingBound =
    boundId !== undefined &&
    boundId !== next.account.id &&
    progress.attemptedAccountIds.includes(boundId)
  const bound = ordered.find((candidate) => candidate.account.id === boundId)

  return {
    action: "attempt",
    candidate: next,
    attempt: progress.attemptedAccountIds.length + 1,
    invalidateBinding: leavingBound,
    sessionRestart: leavingBound && bound?.account.carriesSession === true,
  }
}
