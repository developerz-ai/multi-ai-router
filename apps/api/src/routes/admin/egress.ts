import { Hono, type MiddlewareHandler } from "hono"
import { DEFAULT_ADMIN_JSON_MAX_BYTES } from "../../config/admin-bodies"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import {
  type EgressProxyService,
  replaceModeBody,
  setEgressProxyBody,
  testEgressProxyBody,
} from "../../services/accounts"
import { readJsonBody, validate, validateId } from "../../services/admin"
import { render } from "./render"

/** The proxies an operator can choose from, which one an account leaves through, and their health. */
export const ADMIN_EGRESS_BASE_PATH = "/api/admin/egress-proxies"

export interface AdminEgressRoutesDeps {
  readonly maximumJsonBytes?: number
  readonly service: EgressProxyService
  /** `adminAuth(adminAuthService)`. Required, so no mount can forget the guard. */
  readonly guard: MiddlewareHandler<AdminAuthEnv>
}

export function adminEgressRoutes(deps: AdminEgressRoutesDeps): Hono<AdminAuthEnv> {
  const routes = new Hono<AdminAuthEnv>()
  routes.use("*", deps.guard)

  routes.get("/", async (c) => render(c, await deps.service.list()))

  routes.post("/test", async (c) => {
    const body = validate(
      testEgressProxyBody,
      await readJsonBody(c.req.raw, {
        maximumBytes: deps.maximumJsonBytes ?? DEFAULT_ADMIN_JSON_MAX_BYTES,
      }),
    )
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.test(body.value))
  })

  routes.post("/accounts/:id/test", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.testAccount(id.value))
  })

  routes.patch("/accounts/:id/replace", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    const body = validate(
      replaceModeBody,
      await readJsonBody(c.req.raw, {
        maximumBytes: deps.maximumJsonBytes ?? DEFAULT_ADMIN_JSON_MAX_BYTES,
      }),
    )
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.setReplace(id.value, body.value))
  })

  routes.patch("/accounts/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    const body = validate(
      setEgressProxyBody,
      await readJsonBody(c.req.raw, {
        maximumBytes: deps.maximumJsonBytes ?? DEFAULT_ADMIN_JSON_MAX_BYTES,
      }),
    )
    if (!body.ok) return render(c, body)
    return render(c, await deps.service.set(id.value, body.value))
  })

  routes.delete("/accounts/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.clear(id.value))
  })

  return routes
}
