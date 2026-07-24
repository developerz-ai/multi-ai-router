import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { describeProviders } from "../../services/accounts"

/**
 * The provider registry, read-only.
 *
 * This endpoint exists so the console's "add account" form does not hard-code a
 * provider list, an auth style, or which providers need an operator-supplied
 * base URL. Adding a provider is one file under `providers/` (CLAUDE.md
 * non-negotiable 12) — if the SPA had its own copy of the list, it would be two.
 *
 * There is no POST, PATCH, or DELETE, and there never will be: a Provider is a
 * *kind* of upstream defined in code, not a row. It sits behind the admin guard
 * anyway, because the set of providers a deployment can reach is configuration.
 */

export const ADMIN_PROVIDERS_BASE_PATH = "/api/admin/providers"

export interface AdminProviderRoutesDeps {
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminProviderRoutes(deps: AdminProviderRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", (c) => c.json({ providers: describeProviders() }))

  return routes
}
