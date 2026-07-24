// How an admin-plane failure becomes something a human can read.
//
// The API renders every non-`/v1` failure in the OpenAI error shape —
// `{ error: { message, type, param, code } }` — because `dialectForPath`
// returns null for the admin plane (`apps/api/src/errors/render.ts`). The
// Anthropic shape is accepted too, so a future mount that speaks it does not
// silently degrade to "Request failed".
//
// The rule this module exists to enforce: **the operator sees `message`, never
// a bare status.** A 409 from a pool delete names the keys that would be
// narrowed, and that sentence is the entire value of the response — swallowing
// it and printing "Conflict" throws away the only actionable thing the server
// said.

/** Statuses the console reacts to structurally rather than by rendering text. */
export const UNAUTHORIZED = 401
export const CONFLICT = 409

export interface ParsedError {
  readonly message: string
  /** `invalid_request_error`, `permission_error`, … */
  readonly type: string | null
  /** The stable machine code — `account_in_use`, `pool_in_use`, `not_found`. */
  readonly code: string | null
}

/**
 * Pulls the three fields out of either error shape. Pure and total: anything
 * unrecognised returns null so the caller can fall back on its own wording
 * rather than printing `[object Object]`.
 */
export function parseErrorBody(body: unknown): ParsedError | null {
  if (typeof body !== "object" || body === null) return null
  const error = (body as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return null

  const message = (error as { message?: unknown }).message
  if (typeof message !== "string" || message.length === 0) return null

  const type = (error as { type?: unknown }).type
  const code = (error as { code?: unknown }).code

  return {
    message,
    type: typeof type === "string" ? type : null,
    code: typeof code === "string" ? code : null,
  }
}

/**
 * A failed admin request. Carries the status for the few places that branch on
 * it (401 → session gone, 409 → the destructive-action explanation) and the
 * server's own sentence for everywhere else.
 */
export class ApiError extends Error {
  readonly status: number
  readonly type: string | null
  readonly code: string | null

  constructor(status: number, parsed: ParsedError) {
    super(parsed.message)
    this.name = "ApiError"
    this.status = status
    this.type = parsed.type
    this.code = parsed.code
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** True when the failure is the state refusing, not the input being wrong. */
export function isConflict(value: unknown): boolean {
  return isApiError(value) && value.status === CONFLICT
}

const FALLBACK: Readonly<Record<number, string>> = {
  400: "The router rejected that request.",
  401: "Your session has expired.",
  403: "That is not permitted.",
  404: "That no longer exists.",
  409: "The router refused: something still references this.",
  413: "That request is too large.",
  429: "Too many requests — slow down.",
  500: "The router failed to answer.",
  502: "The router is unreachable.",
  503: "The router is unavailable.",
}

export function toApiError(status: number, body: unknown): ApiError {
  const parsed = parseErrorBody(body)
  if (parsed !== null) return new ApiError(status, parsed)
  return new ApiError(status, {
    message: FALLBACK[status] ?? `The router answered ${status}.`,
    type: null,
    code: null,
  })
}

/** The last resort: a network failure has no body and no status to render. */
export const OFFLINE_MESSAGE = "Could not reach the router. Check that it is running."

/**
 * One sentence for any thrown value. Every error surface in the console renders
 * through this, so an unexpected throw can never leak a stack trace into the UI.
 */
export function errorMessage(value: unknown): string {
  if (isApiError(value)) return value.message
  if (value instanceof TypeError) return OFFLINE_MESSAGE
  if (value instanceof Error && value.message.length > 0) return value.message
  return "Something went wrong."
}
