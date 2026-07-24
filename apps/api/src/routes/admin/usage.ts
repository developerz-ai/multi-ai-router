import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { validate } from "../../services/admin"
import { type UsageService, usageWindowQuery } from "../../services/usage-read"
import { render } from "./render"

/**
 * The usage surface — totals, a sparkline series, and breakdowns per key, account, pool and
 * model, over a named window or a custom range.
 *
 * `GET`, and the only admin group that is read-only: nothing here mutates, so nothing here needs
 * a CSRF token. Usage is a headline surface rather than a tab afterthought
 * (CLAUDE.md, Frontend), which is why the whole screen is one request instead of a call per tile.
 */

export const ADMIN_USAGE_BASE_PATH = "/api/admin/usage"

export interface AdminUsageRoutesDeps {
  readonly service: UsageService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminUsageRoutes(deps: AdminUsageRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => {
    const query = validate(usageWindowQuery, c.req.query())
    if (!query.ok) return render(c, query)
    return render(c, await deps.service.summary(query.value))
  })

  return routes
}
