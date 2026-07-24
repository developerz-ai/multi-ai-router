import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../types"

/**
 * Assigns the correlation id at ingress and propagates it — one id joins the client request,
 * every upstream attempt, every log line, and every `UsageRecord` row.
 */

export const REQUEST_ID_HEADER = "x-request-id"

/** A caller-supplied id is honored only if it cannot poison a header or a log line. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const supplied = c.req.header(REQUEST_ID_HEADER)
    const reusable = supplied !== undefined && SAFE_REQUEST_ID.test(supplied)
    const id = reusable ? supplied : crypto.randomUUID()
    c.set("requestId", id)
    c.header(REQUEST_ID_HEADER, id)
    await next()
  }
}
