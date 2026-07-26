import {
  type Dialect,
  RetryableRouterError,
  type RouterError,
  type RouterErrorCode,
} from "@multi-ai-router/core"
import { type FailureClassification, toRouterError } from "../../providers"
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

/**
 * The failure an attempt that reached its upstream contributes: the driver's classification when it
 * produced a router-shaped verdict, and the provider's own answer when it did not. The verdict wins
 * over the body it arrived with — a spent window is a `429` with a `Retry-After`, not a relayed
 * rate-limit page — and an attempt whose upstream never spoke at all contributes nothing, leaving
 * whatever an earlier candidate established in place.
 */
export function answeredFailure(
  classification: FailureClassification | null,
  upstream: UpstreamError | null,
  dialect: Dialect | null,
): ChainFailure | null {
  const error = classification === null ? null : toRouterError(classification)
  if (error !== null) return { kind: "router", error }
  return upstream === null ? null : { kind: "upstream", upstream, dialect }
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
