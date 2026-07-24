import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import {
  type AccountsService,
  accountListQuery,
  createAccountBody,
  updateAccountBody,
} from "../../services/accounts"
import { readJsonBody, validate, validateId } from "../../services/admin"
import { render } from "./render"

/**
 * Upstream account CRUD. Mountable on its own, because `app.ts` owns the
 * wiring — see docs/idea/04-api-keys-and-access.md#admin-api-route-groups.
 *
 * Thin, as CLAUDE.md requires: parse → validate with Zod → one service call →
 * render. Every rule about what an account may look like, what is encrypted, and
 * what is audited lives in `services/accounts/`.
 *
 * `DELETE` is the hard delete and is deliberately the *second* option in the UI:
 * `POST /:id/disable` is the soft one, which keeps the id, the pool membership,
 * and the joinable usage history.
 */

export const ADMIN_ACCOUNTS_BASE_PATH = "/api/admin/accounts"

export interface AdminAccountRoutesDeps {
  readonly service: AccountsService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminAccountRoutes(deps: AdminAccountRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => {
    const query = validate(accountListQuery, c.req.query())
    if (!query.ok) return render(c, query)
    return render(c, await deps.service.list(query.value))
  })

  routes.post("/", async (c) => {
    const body = validate(createAccountBody, await readJsonBody(c.req.raw))
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
    const body = validate(updateAccountBody, await readJsonBody(c.req.raw))
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.update(id.value, body.value))
  })

  routes.post("/:id/disable", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.disable(id.value))
  })

  routes.delete("/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.remove(id.value))
  })

  return routes
}
