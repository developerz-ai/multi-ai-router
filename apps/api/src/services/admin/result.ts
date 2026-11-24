import { type ErrorBody, REQUEST_WALL, refusalBody } from "../../errors/render"
import type { RouterVerdict } from "../../errors/router-object"

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

/**
 * What an admin surface can produce. `429` is the caller's own pace; `503` is a dependency that did
 * not answer, never a bug.
 */
export type AdminFailureStatus = 400 | 404 | 409 | 429 | 503

export interface AdminFailure {
  readonly status: AdminFailureStatus
  /** Machine-readable, stable, and the same shape the data plane uses. */
  readonly code: string
  readonly message: string
  /** Set exactly when resending the same request unchanged can succeed: how long to wait first. */
  readonly retryAfterSeconds?: number
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

/** How long a caller waits before resending a request a dependency did not answer. */
const UNAVAILABLE_RETRY_SECONDS = 5

/** Nothing is wrong with the request: something this router asked did not answer. Resend it. */
export function unavailable(
  message: string,
  code: string,
  retryAfterSeconds: number = UNAVAILABLE_RETRY_SECONDS,
): AdminResult<never> {
  return { ok: false, failure: { status: 503, code, message, retryAfterSeconds } }
}

/** The caller asked again before the router would do it again. */
export function tooSoon(
  message: string,
  code: string,
  retryAfterSeconds: number,
): AdminResult<never> {
  return { ok: false, failure: { status: 429, code, message, retryAfterSeconds } }
}

/**
 * The admin plane speaks no provider dialect, so failures render in the OpenAI
 * shape — the same default `errors/render.ts` gives every non-`/v1` path — with
 * `error.router` beside the sentence. A `400`/`404`/`409` is wrong in the request
 * itself, so its wall is `request`; a `429`/`503` clears by itself, so its wall is the clock.
 */
export function failureBody(failure: AdminFailure, requestId: string | null): ErrorBody {
  const { retryAfterSeconds } = failure
  const verdict: RouterVerdict =
    retryAfterSeconds === undefined
      ? REQUEST_WALL
      : { wall: "clock", scope: "request", retryAfterSeconds }
  return refusalBody(null, failure.status, failure.message, failure.code, verdict, requestId)
}
