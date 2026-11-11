/**
 * Failover's failure vocabulary: what an attempt's refusal *was*, and whether it justifies the next
 * candidate. Split from the planner (`failover.ts`), which decides what to do about one.
 */

import type { ResetSource } from "@multi-ai-router/core"

export type FailureKind =
  | "rate-limited"
  | "credits-exhausted"
  | "server-error"
  | "connection"
  | "timeout"
  | "auth"
  | "client-error"
  /**
   * The upstream refused the model name itself. About the request's model *and* this account
   * together: the next account may serve a different vendor's names, so it is retryable — and the
   * account answered correctly, so `breaker.ts` never strikes for it.
   */
  | "model-unsupported"
  /** SDK path: `No conversation found with session ID` on the account that owns it. */
  | "stale-session"
  /**
   * SDK path: the CLI refuses to resume a session it is already running. About the *conversation*,
   * not the account — see {@link RETRYABLE_FAILURE_KINDS} and `breaker.ts`.
   */
  | "busy-session"
  /**
   * The provider's shared backend is busy (`UpstreamFailureKind` `overloaded`). Retryable — the next
   * account, then the same one again after a backoff ({@link planNextAttempt}) — and blameless: the
   * breaker never strikes for it, so no account cools or waits on a recovery permit over it.
   */
  | "overloaded"

export interface AttemptFailure {
  readonly kind: FailureKind
  readonly status?: number
  readonly resetsAt?: Date
  readonly retryAfterSeconds?: number
  /** How the reset instant was obtained. Defaults to `provider-reported` when one is present. */
  readonly resetSource?: ResetSource
  readonly message: string
  /**
   * The refusal is provoked by this **request's** content, not by the account (the Agent SDK's
   * `claude-sdk:extra-usage-gated`: an unscrubbed harness preamble every subscription refuses
   * alike). Retryable once, blameless — `breaker.ts` never strikes for it — and a second such
   * answer in one chain ends the walk as a request wall ({@link REQUEST_WALL_AFTER}), never a
   * router `429` (plan 101, 05.14).
   */
  readonly requestAttributable?: boolean
}

/**
 * Failures that justify walking to the next candidate.
 *
 * `auth` is here because a rejected credential is account-scoped: the breaker has already parked
 * the account (`needs_reauth` for a token, a `credential-rejected` cooldown for a key) by the time
 * this is consulted, and
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
  "model-unsupported",
  "overloaded",
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
