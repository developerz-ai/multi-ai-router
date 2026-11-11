/**
 * The errors a request or an admin credential is answered with on its own merits — split from
 * `errors.ts`, which keeps the routing and upstream failures. Re-exported from there.
 */

import { RouterError } from "./errors-base"
import type { RouterErrorInit } from "./wall"

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
  /**
   * Operator-only diagnostic: *which* check rejected the sign-in. Never rendered — the response
   * body is built from `message` and `code` alone (`errors/render.ts`), and the message is the one
   * generic sentence every rejection shares. This field is the other half of that trade: the
   * browser learns nothing, the log line names the kind.
   *
   * It exists because the alternative in practice was a `console.error` beside the throw, which
   * produced an unstructured line with no `requestId` and no level — unfindable in a log
   * aggregator, which is precisely where an operator debugging a failed login looks. Carrying the
   * kind on the error instead lets the transport log it on the line it already writes.
   *
   * Never put credential material here: it reaches a log, and only the field redactor stands
   * between the two.
   */
  readonly reason: string | undefined

  constructor(message: string, init: AdminAuthInit = {}) {
    super(message, init)
    this.reason = init.reason
  }
}

export interface AdminAuthInit extends RouterErrorInit {
  /** See {@link AdminAuthError.reason}. Operator-facing, never rendered. */
  readonly reason?: string
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
 * A cross-dialect conversion cannot be performed faithfully. Raised *before* the upstream call
 * and named after the offending field, because silently dropping a contract field is a bug.
 */
export class TranslationError extends RouterError {
  readonly code = "translation_failed"
  readonly status = 400
}

/**
 * The requested model is served by no account the presenting key can reach. Two throw sites:
 *
 * - `GET /v1/models/:id` — a catalog lookup for an id the key cannot reach (unknown entirely, or
 *   filtered out of its scope), rendered "not found" whatever kept every account from claiming it.
 * - **routing**, when no in-scope account serves the model at all (101, 10.21). That is a client
 *   change, not an outage: `404`, logged at `warn`, no `Retry-After`. It used to be a `503`
 *   `no_healthy_account`, which invited retries and paged as a server error.
 *
 * The message still names the reason.
 */
export class ModelNotFoundError extends RouterError {
  readonly code = "model_not_found"
  readonly status = 404
}

/**
 * The request body is larger than the configured ceiling (`MAX_REQUEST_BODY_BYTES`).
 *
 * `413`, deliberately not the `400` a {@link TranslationError} carries. Both are the caller's to
 * fix, but the remedies are opposites: `400` says "your request is malformed", which sends a
 * developer looking for a bad field in a body that was perfectly well formed and merely long. `413`
 * says "send less, or ask the operator to raise the ceiling", which is the truth. Anthropic and
 * OpenAI both spell this status the same way, so a client already knows what to do with it.
 */
export class RequestTooLargeError extends RouterError {
  readonly code = "request_too_large"
  readonly status = 413
}

/**
 * The request was refused at the router's own edge, before anything was routed or translated: its
 * body is empty, names no model, or names one too long to be one. `400`, and deliberately not
 * {@link TranslationError} — nothing was converted, and `translation_failed` on these lines sent
 * an operator looking for a dialect problem in a request that never reached a dialect.
 */
export class InvalidRequestError extends RouterError {
  readonly code = "invalid_request"
  readonly status = 400
}

/**
 * The request body arrived under a `Content-Encoding` the router does not decode. `415`, the
 * status RFC 9110 gives exactly this, and its own class because the remedy is not "fix a field":
 * the body may be perfectly well formed underneath, and the caller only has to stop compressing it.
 */
export class UnsupportedContentEncodingError extends RouterError {
  readonly code = "unsupported_content_encoding"
  readonly status = 415
}
