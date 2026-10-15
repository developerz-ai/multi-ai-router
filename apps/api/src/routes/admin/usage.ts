import { type Context, Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { ok, validate } from "../../services/admin"
import {
  recentQuery,
  USAGE_FILTER_PARAMS,
  type UsageService,
  usageFilterQuery,
  usageWindowQuery,
} from "../../services/usage-read"
import { render } from "./render"

/**
 * The usage surface — totals, a sparkline series, and breakdowns per key, account, pool and
 * model, over a named window or a custom range.
 *
 * `GET`, and the only admin group that is read-only: nothing here mutates, so nothing here needs
 * a CSRF token. Usage is a headline surface rather than a tab afterthought
 * (CLAUDE.md, Frontend), which is why the whole screen is one request instead of a call per tile.
 *
 * `/recent` is the second path rather than a field on the first because the two refresh at
 * different rates and answer different questions: the summary is an aggregate over a window, the
 * feed is the last N attempts as they happened. Folding the feed into the summary would make every
 * window switch re-read rows nobody asked to see again.
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

  // The six filters are repeated params (`?owner=a&owner=b`), read as arrays; window, from and
  // to are single-valued, and a repeated one keeps today's first-value-wins behaviour. One reader
  // for the summary and the export, so they cannot disagree about what a query means.
  const readQuery = (c: Context<AdminAuthEnv>) => {
    const all = c.req.queries()
    const filters: Record<string, string[]> = {}
    for (const name of USAGE_FILTER_PARAMS) {
      const values = all[name]
      if (values !== undefined) filters[name] = values
    }
    const query = validate(usageWindowQuery, c.req.query())
    if (!query.ok) return query
    const filter = validate(usageFilterQuery, filters)
    if (!filter.ok) return filter
    return ok({ query: query.value, filter: filter.value })
  }

  routes.get("/", async (c) => {
    const read = readQuery(c)
    if (!read.ok) return render(c, read)
    return render(c, await deps.service.summary(read.value.query, read.value.filter))
  })

  // The same filters as the summary, as a CSV attachment. `no-store`: it is an authenticated
  // report, and a shared cache must not keep a copy. A rejection (400 over the cap) renders as the
  // JSON error every admin route uses, never a truncated 200.
  routes.get("/export.csv", async (c) => {
    const read = readQuery(c)
    if (!read.ok) return render(c, read)
    const result = await deps.service.exportCsv(read.value.query, read.value.filter)
    if (!result.ok) return render(c, result)
    return c.body(result.value.body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.value.filename}"`,
      "Cache-Control": "no-store",
    })
  })

  // Registered after `/` and before nothing: Hono matches literal segments exactly, so the two
  // cannot shadow each other whichever order they are declared in.
  routes.get("/recent", async (c) => {
    const query = validate(recentQuery, c.req.query())
    if (!query.ok) return render(c, query)
    return render(c, await deps.service.recent(query.value))
  })

  return routes
}
