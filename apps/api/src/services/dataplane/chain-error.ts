import {
  type Dialect,
  RetryableRouterError,
  type RouterError,
  type RouterErrorCode,
  UpstreamTimeoutError,
} from "@multi-ai-router/core"
import type { FailureClassification, RateLimitSignal } from "../../providers"
// Deep import: the providers barrel does not re-export `FailureContext`, and that file is
// owned by another change set right now. Fold into `../../providers` when it does.
import { type FailureContext, toRouterError } from "../../providers/failure/router-error"
import type { FailureKind } from "../routing"
import type { UpstreamError } from "./attempt"

/**
 * Which of a chain's failed attempts the client hears about.
 *
 * Every candidate fails for its own reason, and the reason the client is owed is not the last one
 * recorded — it is the one that says the most true thing about the *pool*. A credential the router
 * cannot decrypt on candidate 3 is the router's own broken state on one account; letting it land
 * last erases candidate 1's honest `429` and the `Retry-After` that came with it, so a client that
 * should have waited thirty seconds is handed a `500` and retries blind.
 *
 * The pre-attempt half of this decision already exists and is decided the same way:
 * `routing/no-candidates.ts` folds a set of *unavailable* accounts into one error, and its rule for
 * mixed causes is "the recoverable one — 429 if any account has a reset". This is that rule applied
 * after the attempts, where the causes arrive one at a time instead of all at once.
 *
 * One principle orders the table: **prefer the answer that hands someone a next step, and prefer
 * the cheapest next step.**
 *
 * | Failure | Next step |
 * |---|---|
 * | A clock fixes it — `429` | wait `Retry-After`, then the pool serves |
 * | A human fixes it — `402` top up, `502` re-authenticate | one named action |
 * | The upstream answered | whatever the provider said, in its own words |
 * | *This one account* could not take *this request* — `400` no faithful conversion, `500` unreadable credential | nothing the caller can use |
 *
 * The top row outranks every verdict a *different* account gave, because the pool is serviceable
 * again at its earliest reset: telling a caller "no timer will fix this" while one account cools
 * down for thirty seconds is false (CLAUDE.md non-negotiable 7). The bottom row is the same
 * argument inverted — an account that answered at all has proved the request itself was not the
 * problem, so a refusal specific to one account never speaks for the chain.
 *
 * Ties keep the incumbent, so the earliest attempt is the one named — except between two
 * clock-recoverable failures, where the sooner wait wins: the pool is free at the first reset, not
 * the last.
 */

export type ChainFailure =
  | { readonly kind: "router"; readonly error: RouterError }
  | {
      readonly kind: "upstream"
      readonly upstream: UpstreamError
      /** The dialect the body must be re-rendered into, or `null` when it already is the client's. */
      readonly dialect: Dialect | null
    }

/**
 * Higher wins. Total over the code union deliberately: a new `RouterError` class does not compile
 * until someone has decided what it means for a caller holding one of these instead.
 */
const RANK: Readonly<Record<RouterErrorCode, number>> = {
  // Settled before a chain starts (the presented key, its scope, the size of the body), off the
  // data plane entirely (the admin console), or answered by a catalog lookup rather than a
  // dispatch. None can reach this fold. They rank above everything rather than at the floor so that
  // a future path which *does* route one here surfaces it, instead of silently folding it away.
  key_revoked: 90,
  scope_violation: 90,
  request_too_large: 90,
  admin_auth_failed: 90,
  csrf_token_invalid: 90,
  model_not_found: 90,
  // A clock fixes it, and this is the only rank that carries a `Retry-After`.
  quota_exhausted: 70,
  key_rate_limited: 70,
  // A named human action fixes it: top the balance up, re-authenticate the account.
  credits_exhausted: 60,
  upstream_auth_failed: 55,
  // Transient like a `429`, but names no instant to come back at.
  upstream_timeout: 50,
  // `UPSTREAM_ANSWERED` sits here: the provider's own reply, relayed.
  //
  // Nothing was attempted and nothing was decided — the floor of the router-shaped answers, but
  // still an answer about the whole pool rather than about one account.
  no_healthy_account: 30,
  // One account's dialect cannot represent this body. Another that took the same body unchanged has
  // already proved the body was fine.
  translation_failed: 20,
  // The router's own broken state on one account — a rotated `ENCRYPTION_KEY`, a corrupt record, an
  // account holding nothing to authenticate with. It names nothing a caller can act on, so it is
  // the floor.
  credential_decrypt_failed: 10,
}

/** The provider's own words: under a router-shaped verdict, over a single account's refusal. */
const UPSTREAM_ANSWERED = 40

/**
 * Folds one attempt's failure into what the chain is holding. Pure, and never destructive: `null`
 * leaves the held failure alone, which is why a candidate that throws something the router cannot
 * classify at all can no longer erase a real verdict from the candidate before it.
 */
export function foldChainFailure(
  held: ChainFailure | null,
  next: ChainFailure | null,
): ChainFailure | null {
  if (next === null) return held
  if (held === null) return next

  const heldRank = rankOf(held)
  const nextRank = rankOf(next)
  if (nextRank !== heldRank) return nextRank > heldRank ? next : held
  return sooner(held, next)
}

/**
 * The failure a router-shaped throw contributes: a credential that would not decrypt, a body with
 * no faithful conversion into this account's dialect, a deadline the SDK transport raised itself.
 */
export function routerFailure(error: RouterError): ChainFailure {
  return { kind: "router", error }
}

/** What the attempt knew beside its classification — see each field's note. */
export interface AnsweredFailureContext {
  /**
   * The rate-limit reading the attempt captured off its own transport. On the SDK path the reset
   * instant rides the query stream's `rate_limit_event`, never the throw, so the classification
   * carries none — without this, an SDK 429 rendered with no `Retry-After` and the client
   * retried blind (non-negotiable 7).
   */
  readonly rateLimit: RateLimitSignal | null
  /** The attempt's clock reading, for deriving a `Retry-After` from a reported instant. */
  readonly now: Date
  /**
   * The router-authored sentence for this failure (`AttemptFailure.message`). Rendered only when
   * the transport produced a classification but no upstream body — never the SDK's own words.
   */
  readonly clientMessage: string
  /**
   * Failover's own reading of the failure (`AttemptFailure.kind`). Read for one value: `timeout`,
   * the transport failure that carries a verdict of its own — see below.
   */
  readonly failureKind?: FailureKind
}

/**
 * The failure an attempt that reached its upstream contributes: the driver's classification when it
 * produced a router-shaped verdict, and the provider's own answer when it did not. The verdict wins
 * over the body it arrived with — a spent window is a `429` with a `Retry-After`, not a relayed
 * rate-limit page — and an attempt whose upstream never spoke at all contributes nothing, leaving
 * whatever an earlier candidate established in place.
 *
 * One transport classifies without a body: the Agent SDK throws prose, so a subprocess crash or a
 * busy session arrives here with a classification and `upstream === null`. Contributing nothing
 * there collapsed every such failure into a generic `NoHealthyAccountError` — a crashed subprocess
 * indistinguishable from an empty pool — so the classification's own status and the router-authored
 * message are preserved as a synthesized upstream answer instead. Synthesized in the account's
 * dialect (Anthropic — the only classify-without-body transport is the SDK), so the ordinary
 * relay path re-renders it for the client exactly as it would a provider's own body.
 */
export function answeredFailure(
  classification: FailureClassification | null,
  upstream: UpstreamError | null,
  dialect: Dialect | null,
  context?: AnsweredFailureContext,
): ChainFailure | null {
  const failure: FailureContext | undefined =
    context === undefined
      ? undefined
      : {
          signal: context.rateLimit,
          now: context.now,
          // Only for a transport that classified **without** a body — the Agent SDK. There
          // `AttemptFailure.message` is the router-authored sentence; on the HTTP path the same
          // field carries the classification's signal token, which is a log breadcrumb and not a
          // sentence anyone should read in a `429`.
          ...(upstream === null ? { clientMessage: context.clientMessage } : {}),
        }
  const error = classification === null ? null : toRouterError(classification, failure)
  if (error !== null) return { kind: "router", error }
  if (upstream !== null) return { kind: "upstream", upstream, dialect }
  // A deadline the HTTP transport hit is a verdict, not silence: `UpstreamTimeoutError` (504) has
  // sat in the rank table for exactly this, and nothing on the HTTP path ever produced one — so a
  // chain whose every attempt timed out fell through to the "nothing was attempted" 503. That
  // status says the pool is empty when the truth is that it was reached and did not answer in
  // time, and a coding agent's retry policy reads the two differently. A connect failure still
  // contributes nothing: it says the account was never reached, which is what "nothing" means.
  if (classification === null && context?.failureKind === "timeout") {
    return { kind: "router", error: new UpstreamTimeoutError(context.clientMessage) }
  }
  if (classification === null || context === undefined) return null
  return {
    kind: "upstream",
    upstream: synthesizedUpstream(classification.status, context.clientMessage),
    dialect,
  }
}

/**
 * An Anthropic-shaped error body for a classified failure that produced no body of its own. The
 * message is router-authored by contract ({@link AnsweredFailureContext.clientMessage});
 * `api_error` because naming a finer type is the classifier's job, and it already spoke through
 * the status.
 */
function synthesizedUpstream(status: number, message: string): UpstreamError {
  return {
    status,
    headers: new Headers(),
    bodyText: JSON.stringify({ type: "error", error: { type: "api_error", message } }),
    contentType: "application/json",
  }
}

function rankOf(failure: ChainFailure): number {
  return failure.kind === "upstream" ? UPSTREAM_ANSWERED : RANK[failure.error.code]
}

/**
 * Between two failures of equal rank, the one that lets the caller come back sooner. A stated wait
 * beats no wait; otherwise the incumbent stays, so the account the chain tried first is the one
 * named.
 */
function sooner(held: ChainFailure, next: ChainFailure): ChainFailure {
  const heldWait = waitSeconds(held)
  const nextWait = waitSeconds(next)
  if (nextWait === null) return held
  if (heldWait === null) return next
  return nextWait < heldWait ? next : held
}

function waitSeconds(failure: ChainFailure): number | null {
  if (failure.kind !== "router") return null
  if (!(failure.error instanceof RetryableRouterError)) return null
  return failure.error.retryAfterSeconds ?? null
}
