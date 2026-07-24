import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { readJsonBody, validate, validateId } from "../../services/admin"
import { createPoolBody, type PoolsService, updatePoolBody } from "../../services/pools"
import { render } from "./render"

/**
 * Pool CRUD: membership, per-member weight and priority, the routing policy, and
 * the optional overflow account — docs/idea/04-api-keys-and-access.md#admin-api-route-groups.
 *
 * There is no separate membership endpoint on purpose. A pool is edited as one
 * object, so `PATCH /:id` with a `members` array replaces the set in a single
 * transaction; a pool is never briefly half-populated and routing never reads a
 * membership list mid-edit.
 */

export const ADMIN_POOLS_BASE_PATH = "/api/admin/pools"

export interface AdminPoolRoutesDeps {
  readonly service: PoolsService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminPoolRoutes(deps: AdminPoolRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => render(c, await deps.service.list()))

  routes.post("/", async (c) => {
    const body = validate(createPoolBody, await readJsonBody(c.req.raw))
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.create(body.value), 201)
  })

  routes.get("/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.get(id.value))
  })

  routes.patch("/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    const body = validate(updatePoolBody, await readJsonBody(c.req.raw))
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.update(id.value, body.value))
  })

  routes.delete("/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.remove(id.value))
  })

  return routes
}
