/**
 * The router's error hierarchy. Every failure the router itself decides on is one of these
 * classes — never a bare `Error`, never a generic `500`.
 *
 * Two invariants hold and are asserted by the unit tests:
 *  - one class, one stable `code`, one stable HTTP `status`;
 *  - `QuotaExhaustedError` (a window that refills on a clock) and `CreditsExhaustedError`
 *    (a balance only a human refills) are separate classes with separate statuses. Conflating
 *    them makes the router retry a dead account on a timer.
 */

import { RouterError } from "./errors-base"
import type { RouterErrorInit } from "./wall"

export { isRouterError, ROUTER_ERROR_CODES, RouterError, type RouterErrorCode } from "./errors-base"
export * from "./errors-client"

/**
 * Candidate filtering produced nothing, for a reason that is neither "rate limited",
 * "out of credits", nor "out of scope" — no account configured, or none supporting the
 * requested model. `503`. One status, three walls (`wall.ts`): `capacity` by default, `human`
 * when only an operator brings an account back, `scope` when no account here serves what was
 * asked. The throw site says which; the type admits no other.
 */
export class NoHealthyAccountError extends RouterError {
  readonly code = "no_healthy_account"
  readonly status = 503
  readonly wall: NoHealthyAccountWall
  /**
   * Seconds until a retry can succeed — kept only on a `capacity` wall, the one a clock clears.
   * A `human` or `scope` wall gets no `Retry-After`: retrying it is what made clients hammer an
   * operator-only `503` for an hour (101, 13.8).
   */
  readonly retryAfterSeconds: number | undefined

  constructor(message: string, init: NoHealthyAccountInit = {}) {
    super(message, init)
    this.wall = init.wall ?? "capacity"
    this.retryAfterSeconds = this.wall === "capacity" ? init.retryAfterSeconds : undefined
  }
}

export type NoHealthyAccountWall = "capacity" | "human" | "scope"

export interface NoHealthyAccountInit extends RouterErrorInit {
  readonly wall?: NoHealthyAccountWall
  /** Dropped unless the wall is `capacity`. */
  readonly retryAfterSeconds?: number
}

export interface RetryableInit extends RouterErrorInit {
  /** Seconds to wait before retrying — rendered as the `Retry-After` header. */
  readonly retryAfterSeconds?: number
}

export interface QuotaExhaustedInit extends RetryableInit {
  /** Absolute instant the spent window refills, when a reset was reported or estimated. */
  readonly resetsAt?: Date
}

/**
 * A failure a clock will fix, and that can therefore say *when* to come back.
 *
 * The base exists so the transport renders `Retry-After` from a capability rather than from a list
 * of classes it has to remember to extend — a `429` with no `Retry-After` makes a client guess, and
 * guessing clients retry in lockstep.
 */
export abstract class RetryableRouterError extends RouterError {
  readonly retryAfterSeconds: number | undefined

  constructor(message: string, init: RetryableInit = {}) {
    super(message, init)
    this.retryAfterSeconds = init.retryAfterSeconds
  }
}

/**
 * A rate-limit window is spent. Temporary and clock-recoverable: the account is
 * `cooling_down`, not dead. `429` plus a `Retry-After`.
 */
export class QuotaExhaustedError extends RetryableRouterError {
  readonly code = "quota_exhausted"
  readonly status = 429
  readonly resetsAt: Date | undefined

  constructor(message: string, init: QuotaExhaustedInit = {}) {
    super(message, init)
    this.resetsAt = init.resetsAt
  }
}

/**
 * The presented router key exceeded **its own** configured ceiling — nothing upstream was asked,
 * and no Account is out of anything.
 *
 * Deliberately not {@link QuotaExhaustedError}, though both are `429`: that one means the operator
 * has no capacity to give right now, this one means one key is spending its allowance faster than
 * the operator allowed. Same status, different owner, different remedy — the caller slows down, or
 * the operator raises the ceiling — so they stay separate codes and separate usage outcomes.
 */
export class KeyRateLimitedError extends RetryableRouterError {
  readonly code = "key_rate_limited"
  readonly status = 429
}

/** Key verification is temporarily busy or changing; the credential itself is not rejected. */
export class KeyVerificationUnavailableError extends RetryableRouterError {
  readonly code = "key_verification_unavailable"
  readonly status = 503
}

/**
 * The balance is drained, the plan expired, or billing failed. Permanent until a human tops up:
 * the account is `exhausted` and carries no reset, so nothing here is retried on a timer.
 * `402` — deliberately a different class *and* a different status from
 * {@link QuotaExhaustedError}.
 */
export class CreditsExhaustedError extends RouterError {
  readonly code = "credits_exhausted"
  readonly status = 402
}

/**
 * The key's scope intersected with the pool's members and came out empty, or the request named
 * an account the key may not reach. Scope always wins; the candidate set is never widened.
 */
export class ScopeViolationError extends RouterError {
  readonly code = "scope_violation"
  readonly status = 403
}

/** The presented router key is unknown, revoked, or expired. */
export class KeyRevokedError extends RouterError {
  readonly code = "key_revoked"
  readonly status = 401
}

/**
 * The upstream rejected our credential — a `401`/`403` from the provider, not from us.
 *
 * `502`, deliberately: the client's own credential was fine and there is nothing they can do
 * about it. Returning `401` here would tell a developer their router key was bad when the real
 * problem is an Account the operator needs to re-authenticate.
 *
 * Distinct from `KeyRevokedError` (the *router* key) and from `AdminAuthError` (the console).
 * Routing marks the offending Account `needs_reauth` and fails over; see
 * docs/idea/05-routing-and-failover.md.
 */
export class UpstreamAuthError extends RouterError {
  readonly code = "upstream_auth_failed"
  readonly status = 502
}

/** The upstream (or the SDK subprocess) did not answer within its deadline. */
export class UpstreamTimeoutError extends RouterError {
  readonly code = "upstream_timeout"
  readonly status = 504
}

/**
 * Every account the request could use answered "overloaded" — the provider's shared backend is
 * busy, not any one credential's window. `503` plus a `Retry-After`, never `quota_exhausted`: no
 * account is out of anything, and none was cooled for it.
 */
export class UpstreamOverloadedError extends RetryableRouterError {
  readonly code = "upstream_overloaded"
  readonly status = 503
}

/**
 * Stored credential material could not be decrypted — a wrong or rotated `ENCRYPTION_KEY`, or a
 * corrupt record. The message never carries ciphertext, key material, or plaintext.
 */
export class CredentialDecryptError extends RouterError {
  readonly code = "credential_decrypt_failed"
  readonly status = 500
}
