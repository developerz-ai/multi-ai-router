import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { readJsonBody, validate, validateId } from "../../services/admin"
import { createKeyBody, type KeysService, updateKeyBody } from "../../services/keys"
import { render } from "./render"

/**
 * Router key CRUD: list, create, reveal, edit limits and bindings, revoke —
 * docs/idea/04-api-keys-and-access.md#admin-api-route-groups.
 *
 * **`POST /:id/reveal`, not `GET`.** Revealing is semantically a read and is
 * audited as one, but it is the only endpoint in the system that returns a live
 * credential, so it goes through the mutating-method path and carries a CSRF
 * token like every other console action. A `GET` that returns a secret is one
 * `<img src>` away from being interesting to an attacker, and the cost of the
 * stricter verb here is a header the SPA already sends.
 *
 * There is no shown-once flow and no rotate endpoint: keys are stored encrypted
 * and re-readable by design (CLAUDE.md non-negotiable 5).
 */

export const ADMIN_KEYS_BASE_PATH = "/api/admin/keys"

export interface AdminKeyRoutesDeps {
  readonly service: KeysService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminKeyRoutes(deps: AdminKeyRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => render(c, await deps.service.list()))

  routes.post("/", async (c) => {
    const body = validate(createKeyBody, await readJsonBody(c.req.raw))
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
    const body = validate(updateKeyBody, await readJsonBody(c.req.raw))
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.update(id.value, body.value))
  })

  routes.post("/:id/reveal", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.reveal(id.value))
  })

  routes.post("/:id/revoke", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.revoke(id.value))
  })

  routes.delete("/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.remove(id.value))
  })

  return routes
}
