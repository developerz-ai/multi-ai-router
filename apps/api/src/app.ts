import { Hono } from "hono"
import type { Logger } from "./logging/logger"
import { adminAuth } from "./middleware/adminAuth"
import { errorHandler, notFoundHandler } from "./middleware/errorHandler"
import { requestLogger } from "./middleware/logger"
import { requestId } from "./middleware/requestId"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "./routes/admin/accounts"
import { ADMIN_AUTH_BASE_PATH, adminAuthRoutes } from "./routes/admin/auth"
import { ADMIN_KEYS_BASE_PATH, adminKeyRoutes } from "./routes/admin/keys"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "./routes/admin/pools"
import { ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes } from "./routes/admin/providers"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "./routes/admin/usage"
import { healthRoutes } from "./routes/health"
import { DATA_PLANE_BASE_PATH, dataPlaneRoutes } from "./routes/v1"
import type {
  Dispatcher,
  HealthStore,
  RouterKeyVerifier,
  RoutingCatalog,
} from "./services/dataplane"
import type { ReadinessProbes } from "./services/health/readiness"
import type { AdminServices, AppEnv } from "./types"

/**
 * Builds the Hono application. A pure factory: no listener, no timers, no `process.env`, no
 * side effect at import time — `main.ts` is the only module that boots anything, and tests get
 * the real app by calling this with stub probes.
 *
 * Two planes are mounted here, and they share nothing but the request id:
 *
 * - **`/api/admin/**`** — cookie session + CSRF, guarded by `adminAuth`. A router API key is
 *   refused outright by that guard, so a data-plane credential can never reach the console.
 * - **`/v1/**`** — router key, guarded by `routerKeyAuth` inside `dataPlaneRoutes`. It has no
 *   path into an admin service.
 *
 * `dataPlane` is optional so a deployment (and a test) can boot the console alone. Health checks
 * are unguarded by design — a probe that needs a credential is a probe that fails during exactly
 * the incident it exists to report.
 */

export interface AppDeps {
  readonly logger: Logger
  readonly probes: ReadinessProbes
  /** Absent means the admin plane is not mounted — the health-only skeleton a test may want. */
  readonly admin?: AdminServices
  readonly dataPlane?: DataPlaneDeps
  /** `Env.trustProxy`. Off by default: an unvetted `X-Forwarded-For` is a login-throttle bypass. */
  readonly trustProxy?: boolean
}

export interface DataPlaneDeps {
  readonly verifier: RouterKeyVerifier
  readonly dispatcher: Dispatcher
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Order matters: the id exists before anything logs, and the logger before anything throws.
  app.use("*", requestId())
  app.use("*", requestLogger(deps.logger))

  app.onError(errorHandler(deps.logger))
  app.notFound(notFoundHandler())

  app.route("/", healthRoutes(deps.probes))

  if (deps.admin !== undefined) {
    mountAdmin(app, deps.admin, deps.trustProxy ?? false)
  }

  if (deps.dataPlane !== undefined) {
    app.route(DATA_PLANE_BASE_PATH, dataPlaneRoutes(deps.dataPlane))
  }

  return app
}

/**
 * The guard is built once and handed to every group, rather than each group building its own from
 * the auth service. One instance means one place where the admin plane's authentication can be
 * got wrong, and every route factory takes it as a **required** field so a new mount cannot
 * silently be added without one.
 *
 * `/auth` is mounted with its own routes rather than under the guard: login is what issues the
 * session, so it cannot require one.
 */
function mountAdmin(app: Hono<AppEnv>, admin: AdminServices, trustProxy: boolean): void {
  const guard = adminAuth(admin.auth)

  app.route(ADMIN_AUTH_BASE_PATH, adminAuthRoutes({ service: admin.auth, trustProxy }))
  app.route(
    ADMIN_ACCOUNTS_BASE_PATH,
    adminAccountRoutes({ guard, service: admin.accounts, recheck: admin.recheck }),
  )
  app.route(ADMIN_POOLS_BASE_PATH, adminPoolRoutes({ guard, service: admin.pools }))
  app.route(ADMIN_KEYS_BASE_PATH, adminKeyRoutes({ guard, service: admin.keys }))
  app.route(ADMIN_USAGE_BASE_PATH, adminUsageRoutes({ guard, service: admin.usage }))
  app.route(ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes({ guard }))
}
