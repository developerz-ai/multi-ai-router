import { type ErrorBody, renderErrorBody } from "../../errors/render"

/**
 * How an admin service reports a rejection.
 *
 * Not a thrown `RouterError`: every class in `packages/core` is a *request
 * outcome on the data plane* with a fixed status (`scope_violation` is 403
 * because a key may not reach an account, `quota_exhausted` is 429 because a
 * window is spent). An admin CRUD rejection — "that pool id does not exist",
 * "this provider needs a base URL" — is none of those, and borrowing one would
 * hand the console an error code that points at entirely the wrong layer.
 *
 * So the services return an outcome and the routes render it. Routes stay thin:
 * one service call, one `c.json`.
 */

/** Only the three an admin CRUD surface can produce. Nothing here is a 5xx. */
export type AdminFailureStatus = 400 | 404 | 409

export interface AdminFailure {
  readonly status: AdminFailureStatus
  /** Machine-readable, stable, and the same shape the data plane uses. */
  readonly code: string
  readonly message: string
}

export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AdminFailure }

export function ok<T>(value: T): AdminResult<T> {
  return { ok: true, value }
}

/** The input is malformed, contradictory, or names something that cannot work. */
export function invalid(message: string, code = "invalid_request"): AdminResult<never> {
  return { ok: false, failure: { status: 400, code, message } }
}

export function notFound(message: string): AdminResult<never> {
  return { ok: false, failure: { status: 404, code: "not_found", message } }
}

/** The request is well-formed but the current state refuses it — a name clash, a live reference. */
export function conflict(message: string, code = "conflict"): AdminResult<never> {
  return { ok: false, failure: { status: 409, code, message } }
}

/**
 * The admin plane speaks no provider dialect, so failures render in the OpenAI
 * shape — the same default `errors/render.ts` gives every non-`/v1` path.
 */
export function failureBody(failure: AdminFailure): ErrorBody {
  return renderErrorBody(null, failure.status, failure.message, failure.code)
}
