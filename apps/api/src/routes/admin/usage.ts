import { type Context, Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { invalid, ok, validate } from "../../services/admin"
import {
  recentQuery,
  USAGE_FILTER_PARAMS,
  type UsageService,
  unknownQueryParam,
  usageFilterQuery,
  usageWindowQuery,
} from "../../services/usage-read"
import type { ReportDeliveryService, UsageReportService } from "../../services/usage-report"
import { render } from "./render"

/**
 * The usage surface — totals, a sparkline series, and breakdowns per key, account, pool and
 * model, over a named window or a custom range.
 *
 * Everything here is a `GET` except two `POST`s: `/reports/preview` and
 * `/reports/:periodStart/deliver`. Both are mutating methods, so the admin guard demands a CSRF
 * token for them like any other `POST` (the guard enforces it, not this file); the console must
 * send the CSRF header. Usage is a headline surface rather than a tab afterthought (CLAUDE.md,
 * Frontend), which is why the whole screen is one request instead of a call per tile.
 *
 * `/recent` is the second path rather than a field on the first because the two refresh at
 * different rates and answer different questions: the summary is an aggregate over a window, the
 * feed is the last N attempts as they happened. Folding the feed into the summary would make every
 * window switch re-read rows nobody asked to see again.
 *
 * `/reports` serves the stored weekly reports (issue #227): the list, one week by its Monday, and
 * a preview that builds the last complete week without storing it. The preview stores nothing —
 * the stored report is the task's alone. `/reports/:periodStart/deliver` (issue #229) re-sends a
 * stored week to the Discord webhook; like every route here it is parse → one service call →
 * render, and a *failed* re-send renders as a 200 whose body says `failed` (see the delivery
 * service for why it must not be a 5xx).
 */

export const ADMIN_USAGE_BASE_PATH = "/api/admin/usage"

export interface AdminUsageRoutesDeps {
  readonly service: UsageService
  readonly reports: UsageReportService
  /** The re-send half of Discord delivery (issue #229). */
  readonly delivery: ReportDeliveryService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminUsageRoutes(deps: AdminUsageRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  // The six filters are repeated params (`?owner=a&owner=b`), read as arrays; window, from and
  // to are single-valued, and a repeated one keeps first-value-wins. One reader for the summary and
  // the export, so they cannot disagree about what a query means.
  const readQuery = (c: Context<AdminAuthEnv>) => {
    const all = c.req.queries()
    // A misspelled filter (`?apiKeyId=`, `?owners=`) must not silently return the unfiltered
    // totals, so any key outside the window and filter parameters is a 400 naming it.
    const unknown = unknownQueryParam(Object.keys(all))
    if (unknown !== undefined) return invalid(`unknown query parameter "${unknown}"`)
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

  // The same window and filters as the summary, as a CSV attachment. `no-store`: it is an
  // authenticated report, and a shared cache must not keep a copy. A rejection (400 over the cap)
  // renders as the JSON error every admin route uses, never a truncated 200.
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

  routes.get("/reports", async (c) => render(c, await deps.reports.list()))

  // A POST because it builds a whole week on demand and is not a link a prefetch should follow.
  // It stores nothing: the stored report is the task's alone.
  routes.post("/reports/preview", async (c) => render(c, await deps.reports.preview()))

  routes.get("/reports/:periodStart", async (c) =>
    render(c, await deps.reports.get(c.req.param("periodStart"))),
  )

  routes.post("/reports/:periodStart/deliver", async (c) =>
    render(c, await deps.delivery.redeliver(c.req.param("periodStart"))),
  )

  return routes
}
