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
  /**
   * SDK path: this account's in-flight limit held for the whole bounded gate wait
   * (`CLAUDE_SDK_QUEUE_WAIT_MS`), so the request could not take a slot on it. Retryable and
   * blameless: the account is healthy and busy, so nothing cools, strikes or probes for it.
   */
  | "account-full"
  /**
   * SDK path: this replica's shared Claude concurrency limit (`CLAUDE_SDK_MAX_CONCURRENCY`) held for the bounded gate wait. One gate is
   * shared by every Claude subscription account, so the chain offers no further subscription
   * candidate in this request (`noteGateFull`); an account of another kind is still tried.
   */
  | "router-full"

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
  /**
   * See `FailureClassification.permanentForRequest`: no clock clears it on this pool. A chain whose
   * every account refused this way, with none untried, ends as the request wall.
   */
  readonly permanentForRequest?: boolean
  /**
   * A throttle on the requested model only (`FailureClassification.modelScoped`): the chain holds
   * that model off the account instead of cooling the account (`dataplane/chain-recovery.ts`).
   */
  readonly modelScoped?: boolean
  /**
   * A `client-error` about this **vendor's wire**, not the request
   * (`FailureClassification.providerScoped`): every account of the same provider answers alike and
   * another vendor may serve the body as it stands. The one `client-error` the chain walks past:
   * it skips that provider's remaining candidates and goes on ({@link planNextAttempt}).
   */
  readonly providerScoped?: boolean
  /**
   * The refusal names the **key's own spend cap** (`FailureClassification.keyCap`: OpenRouter's
   * `limit_source: openrouter_key_limit`, `Key limit exceeded`, `… a key with a higher … limit`),
   * never the prepaid balance. The evidence `plan-reset.ts` requires before a `credits-exhausted`
   * refusal borrows the reset of a cap its reading says is only *nearly* spent.
   */
  readonly keyCap?: boolean
  /**
   * The refusal names the **prepaid balance** (`FailureClassification.namesBalance`:
   * `limit_source: openrouter_credits`, `Insufficient credits`). The opposite evidence to
   * {@link keyCap}, and it outranks it: no key reset refills a balance, so `plan-reset.ts` lends
   * it nothing, a fully spent cap's reset included.
   */
  readonly namesBalance?: boolean
  /**
   * A `client-error` about **this account's own settings** (`FailureClassification.accountScoped`:
   * an OpenRouter provider filter or data policy that leaves no endpoint, one request larger than
   * the account's in-flight budget). The next account may serve the body as it stands, one of the
   * same provider included, so the chain walks on without skipping anything
   * ({@link planNextAttempt}). No strike and no hold: `client-error` never earns either.
   */
  readonly accountScoped?: boolean
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
  "account-full",
  "router-full",
]

/** This router's own Claude gate was full (the account's limit or the replica's ceiling), before any upstream was asked. */
export function isGateFull(kind: FailureKind): kind is "account-full" | "router-full" {
  return kind === "account-full" || kind === "router-full"
}

/**
 * A failure that is a verdict even though the upstream never started: the request's own refusal
 * ({@link AttemptFailure.requestAttributable}), or this router's full gate (`account-full`,
 * `router-full`), which fires before any upstream is asked. Such an attempt takes the failure tail
 * (a usage row, a log line, a fold into the held answer) instead of being dropped as a preparation
 * fault, which would end a walk of full accounts as "could not be prepared".
 */
export function isUnstartedVerdict(failure: Pick<AttemptFailure, "kind" | "requestAttributable">) {
  return failure.requestAttributable === true || isGateFull(failure.kind)
}

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
