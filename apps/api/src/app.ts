import { Hono } from "hono"
import type { Logger } from "./logging/logger"
import { errorHandler, notFoundHandler } from "./middleware/errorHandler"
import { requestLogger } from "./middleware/logger"
import { requestId } from "./middleware/requestId"
import { healthRoutes } from "./routes/health"
import type { ReadinessProbes } from "./services/health/readiness"
import type { AppEnv } from "./types"

/**
 * Builds the Hono application. A pure factory: no listener, no timers, no `process.env`, no
 * side effect at import time — `main.ts` is the only module that boots anything, and tests get
 * the real app by calling this with stub probes.
 */

export interface AppDeps {
  readonly logger: Logger
  readonly probes: ReadinessProbes
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Order matters: the id exists before anything logs, and the logger before anything throws.
  app.use("*", requestId())
  app.use("*", requestLogger(deps.logger))

  app.onError(errorHandler(deps.logger))
  app.notFound(notFoundHandler())

  app.route("/", healthRoutes(deps.probes))

  return app
}
