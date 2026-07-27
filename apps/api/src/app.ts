import { Hono } from "hono"
import type { Logger } from "./logging/logger"
import { adminAuth } from "./middleware/adminAuth"
import { errorHandler, notFoundHandler } from "./middleware/errorHandler"
import { requestLogger } from "./middleware/logger"
import { requestId } from "./middleware/requestId"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "./routes/admin/accounts"
import { ADMIN_AUTH_BASE_PATH, adminAuthRoutes } from "./routes/admin/auth"
import { ADMIN_KEYS_BASE_PATH, adminKeyRoutes } from "./routes/admin/keys"
import { oauthCallbackRoutes } from "./routes/admin/oauth-callback"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "./routes/admin/pools"
import { ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes } from "./routes/admin/providers"
import {
  ADMIN_AUDIT_BASE_PATH,
  ADMIN_SETTINGS_BASE_PATH,
  ADMIN_TASKS_BASE_PATH,
  adminAuditRoutes,
  adminSettingsRoutes,
  adminTaskRoutes,
} from "./routes/admin/settings"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "./routes/admin/usage"
import { healthRoutes } from "./routes/health"
import { type MetricsRouteDeps, metricsRoutes } from "./routes/metrics"
import { spaRoutes } from "./routes/spa"
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
 *
 * The built SPA, when there is one, mounts **last** and at the root: it is the only thing here
 * that answers a path no route claimed, so it must be the last one asked — see `routes/spa.ts`.
 */

export interface AppDeps {
  readonly logger: Logger
  readonly probes: ReadinessProbes
  /** Absent means the admin plane is not mounted — the health-only skeleton a test may want. */
  readonly admin?: AdminServices
  readonly dataPlane?: DataPlaneDeps
  /** Absent means `/metrics` is not mounted at all — a `404`, not an empty exposition. */
  readonly metrics?: MetricsRouteDeps
  /** `Env.trustProxy`. Off by default: an unvetted `X-Forwarded-For` is a login-throttle bypass. */
  readonly trustProxy?: boolean
  /**
   * `Env.adminAuth.sessionCookieInsecure`. Off by default, and the default is the hardened one:
   * the escape hatch drops `Secure`/`__Host-` so a plain-HTTP LAN install can log in at all —
   * `services/admin-auth/cookies.ts`.
   */
  readonly sessionCookieInsecure?: boolean
  /**
   * `Env.adminApiToken`. Absent — the default — means the admin plane accepts a browser session
   * and nothing else; set, it also accepts that bearer token, which is what lets a script, a CI
   * job, or an agent drive the same REST API the console uses
   * (`services/admin-auth/apiToken.ts`).
   */
  readonly adminApiToken?: string | null
  /**
   * Directory holding the built SPA. Absent means no static mount at all — an API-only process,
   * which is what a test boots and what `bin/dev` runs while Vite serves the console itself.
   */
  readonly webRoot?: string
}

/** The transport-shaped settings the admin plane needs, resolved to a value, never absent. */
interface AdminMountOptions {
  readonly trustProxy: boolean
  readonly sessionCookieInsecure: boolean
  readonly apiToken: string | null
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

  // Beside health, and guarded like neither plane: a scrape carries no session and no router key.
  if (deps.metrics !== undefined) {
    app.route("/", metricsRoutes(deps.metrics))
  }

  if (deps.admin !== undefined) {
    mountAdmin(app, deps.admin, {
      trustProxy: deps.trustProxy ?? false,
      sessionCookieInsecure: deps.sessionCookieInsecure ?? false,
      apiToken: deps.adminApiToken ?? null,
    })
  }

  if (deps.dataPlane !== undefined) {
    app.route(DATA_PLANE_BASE_PATH, dataPlaneRoutes(deps.dataPlane))
  }

  // Last. Every API route above is already registered, so the SPA's history-API fallback can only
  // ever answer a path none of them claimed.
  if (deps.webRoot !== undefined) {
    app.route("/", spaRoutes({ root: deps.webRoot }))
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
 * session, so it cannot require one. It still gets `sessionCookieInsecure` from here, so the
 * guard it builds for `/logout` and `/session` reads the cookie back under the mode `/login`
 * wrote it in.
 */
function mountAdmin(app: Hono<AppEnv>, admin: AdminServices, options: AdminMountOptions): void {
  const { trustProxy, sessionCookieInsecure, apiToken } = options
  const guard = adminAuth(admin.auth, sessionCookieInsecure, apiToken)

  app.route(
    ADMIN_AUTH_BASE_PATH,
    adminAuthRoutes({ service: admin.auth, trustProxy, sessionCookieInsecure, apiToken }),
  )
  app.route(
    ADMIN_ACCOUNTS_BASE_PATH,
    adminAccountRoutes({
      guard,
      service: admin.accounts,
      recheck: admin.recheck,
      testNow: admin.testNow,
      discoverModels: admin.discoverModels,
      connect: admin.connect,
    }),
  )
  // Mounted at the root, at its own published path, and without the guard: a provider's redirect
  // is a cross-site navigation that carries no `SameSite=Strict` cookie, and the one-shot `state`
  // is what authorizes it. See `routes/admin/oauth-callback.ts`.
  app.route("/", oauthCallbackRoutes({ connect: admin.connect }))
  app.route(ADMIN_POOLS_BASE_PATH, adminPoolRoutes({ guard, service: admin.pools }))
  app.route(ADMIN_KEYS_BASE_PATH, adminKeyRoutes({ guard, service: admin.keys }))
  app.route(ADMIN_USAGE_BASE_PATH, adminUsageRoutes({ guard, service: admin.usage }))
  app.route(ADMIN_PROVIDERS_BASE_PATH, adminProviderRoutes({ guard }))
  // Three paths, one service: the settings screen reads configuration, task health and the audit
  // feed together — see `services/settings/service.ts`.
  app.route(ADMIN_SETTINGS_BASE_PATH, adminSettingsRoutes({ guard, service: admin.settings }))
  app.route(ADMIN_TASKS_BASE_PATH, adminTaskRoutes({ guard, service: admin.settings }))
  app.route(ADMIN_AUDIT_BASE_PATH, adminAuditRoutes({ guard, service: admin.settings }))
}
