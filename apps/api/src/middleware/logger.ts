import type { MiddlewareHandler } from "hono"
import type { Logger } from "../logging/logger"
import type { AppEnv } from "../types"

/**
 * Binds a request-scoped logger onto the context and writes one `info` line per completed
 * request. A request that throws is logged by the error handler instead, which is the only
 * place that knows the status it ended on.
 */
export function requestLogger(base: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const log = base.child({ component: "transport", requestId: c.get("requestId") })
    c.set("log", log)

    const startedAt = performance.now()
    await next()

    log.info("request completed", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    })
  }
}
