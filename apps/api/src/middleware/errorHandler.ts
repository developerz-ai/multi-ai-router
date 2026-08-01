import { AdminAuthError, isRouterError } from "@multi-ai-router/core"
import type { Context, ErrorHandler, NotFoundHandler } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import {
  dialectForPath,
  type ErrorResponse,
  notFoundResponse,
  toErrorResponse,
} from "../errors/render"
import type { Logger } from "../logging/logger"
import type { AppEnv } from "../types"

/**
 * The one place a thrown value becomes an HTTP response.
 *
 * A `RouterError` renders at its own stable status and code (`packages/core` owns that table);
 * anything else is a `500` with a generic body, its real detail logged and never returned. No
 * error body carries credential material, a stack, or the identity of an account that failed.
 */
export function errorHandler(fallbackLog: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    const response = toErrorResponse(err, dialectForPath(c.req.path))
    const log = c.get("log") ?? fallbackLog

    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: response.status,
      requestId: c.get("requestId"),
    }
    if (isRouterError(err)) {
      const level = response.status >= 500 ? "error" : "warn"
      // `reason` is present only on the errors carrying an operator-only diagnostic —
      // `AdminAuthError` today, whose message is one deliberately uninformative sentence for every
      // rejection. The kind belongs on this line and nowhere else: this is the only place a
      // `requestId` is bound, and the response body is built from `message`/`code` alone, so
      // logging it here cannot widen what the browser learns.
      const reason = err instanceof AdminAuthError ? err.reason : undefined
      log[level]("request failed", {
        ...fields,
        errorClass: err.name,
        errorCode: err.code,
        ...(reason === undefined ? {} : { reason }),
      })
    } else {
      // The message and stack are for the operator only — they never reach the response body.
      log.error("request failed", { ...fields, errorClass: err.name, stack: err.stack })
    }

    return send(c, response)
  }
}

export function notFoundHandler(): NotFoundHandler<AppEnv> {
  return (c) => send(c, notFoundResponse(dialectForPath(c.req.path)))
}

function send(c: Context<AppEnv>, response: ErrorResponse): Response {
  if (response.retryAfterSeconds !== null) {
    c.header("Retry-After", String(response.retryAfterSeconds))
  }
  return c.json(response.body, response.status as ContentfulStatusCode)
}
