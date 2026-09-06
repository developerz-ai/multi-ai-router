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
 * | `401` / `403` | Retry the next candidate. The account is parked `needs_reauth` / `disabled`; a rejected credential is *this account's* problem, not the request's. |
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

import type { ResetSource } from "@multi-ai-router/core"
import type { Candidate } from "./types"

export type FailureKind =
  | "rate-limited"
  | "credits-exhausted"
  | "server-error"
  | "connection"
  | "timeout"
  | "auth"
  | "client-error"
  /** SDK path: `No conversation found with session ID` on the account that owns it. */
  | "stale-session"
  /**
   * SDK path: the CLI refuses to resume a session it is already running. About the *conversation*,
   * not the account — see {@link RETRYABLE_FAILURE_KINDS} and `breaker.ts`.
   */
  | "busy-session"

export interface AttemptFailure {
  readonly kind: FailureKind
  readonly status?: number
  readonly resetsAt?: Date
  readonly retryAfterSeconds?: number
  /** How the reset instant was obtained. Defaults to `provider-reported` when one is present. */
  readonly resetSource?: ResetSource
  readonly message: string
}

/**
 * Failures that justify walking to the next candidate.
 *
 * `auth` is here because a rejected credential is account-scoped: the breaker has already parked
 * the account (`needs_reauth` for a token, `disabled` for a key) by the time this is consulted, and
 * the next candidate authenticates with its own credential. Stopping on it made the first request
 * to land on an expired subscription fail while healthy accounts sat beside it — only the *next*
 * request routed around the parked account. `client-error` stays out: a bad request is bad at every
 * account. Both hold only before a byte reaches the client; `planNextAttempt` checks that first.
 *
 * `busy-session` is here for a third reason, and it is the one that separates *retryable* from
 * *account-scoped*: the SDK transport has already spent its own recovery (the in-place fork) by the
 * time the chain sees one, so the next candidate deserves its turn — but the fault was about the
 * conversation's session, not about the account it happened on, so `breaker.ts` never strikes for
 * it. Retryable and blameless are different questions, and only this kind answers them differently.
 */
export const RETRYABLE_FAILURE_KINDS: readonly FailureKind[] = [
  "rate-limited",
  "credits-exhausted",
  "server-error",
  "connection",
  "timeout",
  "auth",
  "busy-session",
]

export function isRetryable(kind: FailureKind): boolean {
  return RETRYABLE_FAILURE_KINDS.includes(kind)
}

/**
 * Maps an upstream status to a failure kind. `outOfCredits` comes from the driver, because every
 * provider words a drained balance differently and that classification is a driver-level concern.
 * Returns null for a status that is not a failure at all.
 */
export function classifyStatus(
  status: number,
  signals: { readonly outOfCredits?: boolean } = {},
): FailureKind | null {
  if (signals.outOfCredits === true) return "credits-exhausted"
  if (status < 400) return null
  if (status === 429) return "rate-limited"
  if (status === 402) return "credits-exhausted"
  if (status === 401 || status === 403) return "auth"
  if (status >= 500) return "server-error"
  return "client-error"
}

/** A stale SDK session earns exactly one replay in place. */
export const DEFAULT_MAX_IN_PLACE_RETRIES = 1

export interface FailoverOptions {
  /**
   * Operator ceiling on distinct accounts tried for one request. Absent means the pool itself is
   * the ceiling — see {@link maxAttempts}.
   */
  readonly maxAttempts?: number
  readonly maxInPlaceRetries?: number
  /** The account this session is bound to, when it has a binding. */
  readonly boundAccountId?: string
}

export interface FailoverProgress {
  /** In attempt order. Its length is the attempt count that lands in the `UsageRecord`. */
  readonly attemptedAccountIds: readonly string[]
  readonly inPlaceRetries: number
  /** Set the instant the first byte reaches the client. Never unset. */
  readonly bytesStreamed: boolean
}

export const NO_ATTEMPTS: FailoverProgress = {
  attemptedAccountIds: [],
  inPlaceRetries: 0,
  bytesStreamed: false,
}

export type FailoverStopReason =
  | "bytes-streamed"
  | "not-retryable"
  | "attempts-exhausted"
  | "candidates-exhausted"

export type FailoverDecision =
  | {
      readonly action: "attempt"
      readonly candidate: Candidate
      /** 1-based position in the failover chain. */
      readonly attempt: number
      /** The Session -> Account mapping must be dropped: never carried, never migrated. */
      readonly invalidateBinding: boolean
      /**
       * Client-visible truth on the SDK path: a fresh upstream session starts and prior turns
       * are gone. Surfaced, never hidden behind a truncated context or a flattened replay.
       */
      readonly sessionRestart: boolean
    }
  | { readonly action: "retry-in-place"; readonly candidate: Candidate; readonly attempt: number }
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
  if (progress.attemptedAccountIds.length >= maxAttempts(ordered, options)) {
    return { action: "stop", reason: "attempts-exhausted" }
  }

  const attempted = new Set(progress.attemptedAccountIds)
  const next = ordered.find((candidate) => !attempted.has(candidate.account.id))
  if (next === undefined) return { action: "stop", reason: "candidates-exhausted" }

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
  if (options.maxAttempts === undefined) return ordered.length
  const configured = Math.max(1, Math.trunc(options.maxAttempts))
  return Math.min(configured, ordered.length)
}

/** Folds one dispatched attempt into the progress. Returns a new value; nothing mutates. */
export function recordAttempt(
  progress: FailoverProgress,
  accountId: string,
  inPlace = false,
): FailoverProgress {
  return {
    attemptedAccountIds: inPlace
      ? progress.attemptedAccountIds
      : [...progress.attemptedAccountIds, accountId],
    inPlaceRetries: inPlace ? progress.inPlaceRetries + 1 : progress.inPlaceRetries,
    bytesStreamed: progress.bytesStreamed,
  }
}

/** Called the instant the first byte reaches the client. From here nothing may be retried. */
export function markStreamed(progress: FailoverProgress): FailoverProgress {
  return { ...progress, bytesStreamed: true }
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
    sessionRestart: leavingBound && bound?.account.provider === "anthropic-oauth",
  }
}
