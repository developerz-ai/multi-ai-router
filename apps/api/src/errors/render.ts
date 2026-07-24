import { type Dialect, isRouterError, QuotaExhaustedError } from "@multi-ai-router/core"

/**
 * Turns a thrown value into the HTTP status and the dialect-appropriate JSON body the client
 * gets. Pure — no Hono, no logging, no I/O — so the mapping is unit-testable on its own.
 *
 * The status and code come from the `RouterError` instance itself (`packages/core` owns that
 * table); this module only decides how the failure is *rendered*. Anything that is not a
 * `RouterError` is a generic `500`: the real detail is logged, never returned.
 * Shapes: docs/idea/06-protocol-translation.md#error-shapes.
 */

/** An error body is one of two shapes; every OpenAI dialect shares the second. */
export interface AnthropicErrorBody {
  readonly type: "error"
  readonly error: { readonly type: string; readonly message: string }
}

export interface OpenAiErrorBody {
  readonly error: {
    readonly message: string
    readonly type: string
    readonly param: null
    readonly code: string | null
  }
}

export type ErrorBody = AnthropicErrorBody | OpenAiErrorBody

export interface ErrorResponse {
  readonly status: number
  readonly body: ErrorBody
  /** Rendered as the `Retry-After` header when present. */
  readonly retryAfterSeconds: number | null
}

const INTERNAL_ERROR_MESSAGE = "Internal server error"

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  503: "overloaded_error",
}

const OPENAI_ERROR_TYPES: Record<number, string> = {
  401: "authentication_error",
  403: "permission_error",
  429: "rate_limit_error",
}

/**
 * The ingress dialect a path speaks, or null for everything else (admin plane, health, unknown
 * routes) — those render in the OpenAI shape, which is the more widely understood of the two.
 */
export function dialectForPath(path: string): Dialect | null {
  if (path === "/v1/messages") return "anthropic"
  if (path === "/v1/chat/completions") return "openai-chat"
  if (path === "/v1/responses") return "openai-responses"
  return null
}

export function renderErrorBody(
  dialect: Dialect | null,
  status: number,
  message: string,
  code: string | null,
): ErrorBody {
  if (dialect === "anthropic") {
    return { type: "error", error: { type: anthropicErrorType(status), message } }
  }
  return { error: { message, type: openAiErrorType(status), param: null, code } }
}

export function toErrorResponse(error: unknown, dialect: Dialect | null): ErrorResponse {
  if (!isRouterError(error)) {
    return {
      status: 500,
      body: renderErrorBody(dialect, 500, INTERNAL_ERROR_MESSAGE, null),
      retryAfterSeconds: null,
    }
  }
  return {
    status: error.status,
    body: renderErrorBody(dialect, error.status, error.message, error.code),
    retryAfterSeconds:
      error instanceof QuotaExhaustedError ? (error.retryAfterSeconds ?? null) : null,
  }
}

export function notFoundResponse(dialect: Dialect | null): ErrorResponse {
  return {
    status: 404,
    body: renderErrorBody(dialect, 404, "Not found", "not_found"),
    retryAfterSeconds: null,
  }
}

function anthropicErrorType(status: number): string {
  return ANTHROPIC_ERROR_TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error")
}

function openAiErrorType(status: number): string {
  return OPENAI_ERROR_TYPES[status] ?? (status >= 500 ? "server_error" : "invalid_request_error")
}
