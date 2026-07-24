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

export const ROUTER_ERROR_CODES = [
  "no_healthy_account",
  "quota_exhausted",
  "credits_exhausted",
  "scope_violation",
  "key_revoked",
  "admin_auth_failed",
  "csrf_token_invalid",
  "upstream_auth_failed",
  "upstream_timeout",
  "credential_decrypt_failed",
  "translation_failed",
] as const

export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number]

/**
 * Base of the hierarchy. `code` is the machine-readable identifier clients and metrics key on;
 * `status` is the HTTP status the transport layer renders. Both are fixed per subclass — a
 * subclass never negotiates its status at construction time.
 */
export abstract class RouterError extends Error {
  abstract readonly code: RouterErrorCode
  abstract readonly status: number

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    // The subclass name is what `UsageRecord.errorClass` and the logs record.
    this.name = new.target.name
  }
}

/**
 * Candidate filtering produced nothing, for a reason that is neither "rate limited",
 * "out of credits", nor "out of scope" — no account configured, or none supporting the
 * requested model. `503`, because the pool may become serviceable without the caller changing
 * anything.
 */
export class NoHealthyAccountError extends RouterError {
  readonly code = "no_healthy_account"
  readonly status = 503
}

export interface QuotaExhaustedInit extends ErrorOptions {
  /** Seconds to wait before retrying — rendered as the `Retry-After` header. */
  readonly retryAfterSeconds?: number
  /** Absolute instant the spent window refills, when a reset was reported or estimated. */
  readonly resetsAt?: Date
}

/**
 * A rate-limit window is spent. Temporary and clock-recoverable: the account is
 * `cooling_down`, not dead. `429` plus a `Retry-After`.
 */
export class QuotaExhaustedError extends RouterError {
  readonly code = "quota_exhausted"
  readonly status = 429
  readonly retryAfterSeconds: number | undefined
  readonly resetsAt: Date | undefined

  constructor(message: string, init: QuotaExhaustedInit = {}) {
    super(message, init)
    this.retryAfterSeconds = init.retryAfterSeconds
    this.resetsAt = init.resetsAt
  }
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
 * Admin-plane authentication failed: bad credentials, no session, an expired session, or a
 * router API key presented where only an admin session is accepted.
 *
 * Distinct from `KeyRevokedError` on purpose. Both are `401`, but they describe different
 * credential spaces, and the two planes are deliberately separate — a router key can never
 * authenticate the admin plane. Reusing `key_revoked` here would tell an operator staring at a
 * failed console login that their *API key* was revoked, which is both wrong and a genuinely
 * confusing thing to debug.
 *
 * The message must stay generic: never reveal whether the username existed.
 */
export class AdminAuthError extends RouterError {
  readonly code = "admin_auth_failed"
  readonly status = 401
}

/**
 * A mutating admin request arrived without a valid CSRF token.
 *
 * Distinct from `ScopeViolationError` for the same reason as above: both are `403`, but scope
 * violation is a data-plane authorization outcome ("this key may not reach that account"),
 * while this is a request-forgery rejection. A client seeing `scope_violation` on a console
 * action would look in entirely the wrong place.
 */
export class CsrfTokenError extends RouterError {
  readonly code = "csrf_token_invalid"
  readonly status = 403
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
 * Stored credential material could not be decrypted — a wrong or rotated `ENCRYPTION_KEY`, or a
 * corrupt record. The message never carries ciphertext, key material, or plaintext.
 */
export class CredentialDecryptError extends RouterError {
  readonly code = "credential_decrypt_failed"
  readonly status = 500
}

/**
 * A cross-dialect conversion cannot be performed faithfully. Raised *before* the upstream call
 * and named after the offending field, because silently dropping a contract field is a bug.
 */
export class TranslationError extends RouterError {
  readonly code = "translation_failed"
  readonly status = 400
}

/** Narrows an unknown thrown value to a {@link RouterError}. */
export function isRouterError(value: unknown): value is RouterError {
  return value instanceof RouterError
}
