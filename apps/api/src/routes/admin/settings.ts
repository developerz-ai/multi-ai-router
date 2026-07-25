import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { readJsonBody, validate } from "../../services/admin"
import { auditQuery, type SettingsService, updatePriceOverridesBody } from "../../services/settings"
import { render } from "./render"

/**
 * The three groups behind the settings screen —
 * docs/idea/04-api-keys-and-access.md#admin-api-route-groups.
 *
 * They share one service because they are one screen (`services/settings/service.ts`), and they are
 * three groups because they refresh at different rates: configuration is static, task health ticks,
 * and the audit feed is paged.
 *
 * Only `PATCH /api/admin/settings` mutates, and it carries a CSRF token because the guard demands
 * one on every mutating method. The two `GET`s do not, for the reason `routes/admin/usage.ts`
 * states: nothing read-only needs one.
 *
 * The retention windows, the log level and the janitor interval are rendered by the `GET` and have
 * no write path at all. They are environment configuration (CLAUDE.md non-negotiable 11) — the
 * screen's job is to show them and say where they are set.
 */

export const ADMIN_SETTINGS_BASE_PATH = "/api/admin/settings"
export const ADMIN_TASKS_BASE_PATH = "/api/admin/tasks"
export const ADMIN_AUDIT_BASE_PATH = "/api/admin/audit"

/** One shape for all three: one service, and the guard every mount is required to supply. */
export interface AdminSettingsRoutesDeps {
  readonly service: SettingsService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminSettingsRoutes(deps: AdminSettingsRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => render(c, await deps.service.read()))

  // The price overrides are sent as a whole set, so this is one `PATCH` on the collection rather
  // than a row-level CRUD trio — see `services/settings/schema.ts`.
  routes.patch("/", async (c) => {
    const body = validate(updatePriceOverridesBody, await readJsonBody(c.req.raw))
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.update(body.value))
  })

  return routes
}

export function adminTaskRoutes(deps: AdminSettingsRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => render(c, await deps.service.tasks()))

  return routes
}

export function adminAuditRoutes(deps: AdminSettingsRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => {
    const query = validate(auditQuery, c.req.query())
    if (!query.ok) return render(c, query)
    return render(c, await deps.service.audit(query.value))
  })

  return routes
}
