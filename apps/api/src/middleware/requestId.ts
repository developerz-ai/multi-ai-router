import type { MiddlewareHandler } from "hono"
import { createRequestIdentity } from "../services/usage/request-identity"
import type { AppEnv } from "../types"

/**
 * Assigns an independent server-owned attempt join key and preserves safe caller trace labels.
 * Caller labels may repeat; their shape never establishes ownership.
 */

export const REQUEST_ID_HEADER = "x-request-id"

/** A caller-supplied id is honored only if it cannot poison a header or a log line. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const supplied = c.req.header(REQUEST_ID_HEADER)
    const reusable = supplied !== undefined && SAFE_REQUEST_ID.test(supplied)
    const identity = createRequestIdentity(reusable ? supplied : undefined)
    c.set("requestId", identity.requestId)
    c.set("correlationId", identity.correlationId)
    c.set("clientRequestId", identity.clientRequestId)
    c.header(REQUEST_ID_HEADER, identity.requestId)
    await next()
  }
}
