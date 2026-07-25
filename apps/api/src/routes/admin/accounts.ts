import { Hono, type MiddlewareHandler } from "hono"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import {
  type AccountsService,
  accountListQuery,
  type ClaudeConnectService,
  completeConnectBody,
  createAccountBody,
  type RecheckService,
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
 *
 * `POST /recheck` and `POST /:id/recheck` are the operator's "Re-check now" — the
 * all-accounts form is first so it cannot be shadowed by the `/:id` pattern.
 *
 * **Connect is two calls with a live subprocess between them.** `POST /:id/connect`
 * starts the `claude` CLI's own login and answers with the authorization URL it
 * printed; the operator authorizes in a browser and `POST /:id/connect/complete`
 * hands the pasted `code#state` back. `POST /:id/reconnect` is the same call
 * against the same row — the id, the config directory, the pool membership, and
 * the usage history all survive, and only the audit kind differs.
 * `DELETE /:id/connect` abandons a pending login rather than leaving a
 * subprocess to its TTL. Nothing in any of these responses carries a code, a
 * state, or a token (docs/idea/11-anthropic-agent-sdk.md §3.1).
 */

export const ADMIN_ACCOUNTS_BASE_PATH = "/api/admin/accounts"

export interface AdminAccountRoutesDeps {
  readonly service: AccountsService
  readonly recheck: RecheckService
  readonly connect: ClaudeConnectService
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

  // Registered before `/:id`, or Hono would match "recheck" as an account id.
  routes.post("/recheck", async (c) => render(c, await deps.recheck.recheckAll()))

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

  routes.post("/:id/recheck", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.recheck.recheck(id.value))
  })

  // Same service call as `/:id/connect`; the mode is only what the operator called it.
  routes.post("/:id/reconnect", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.connect.begin(id.value, "reconnect"))
  })

  routes.post("/:id/connect", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.connect.begin(id.value, "connect"))
  })

  routes.post("/:id/connect/complete", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    const body = validate(completeConnectBody, await readJsonBody(c.req.raw))
    if (!body.ok) return render(c, body)
    return render(c, await deps.connect.complete(id.value, body.value.pasted))
  })

  // Abandons a pending login now instead of at its TTL, terminating the subprocess with it.
  routes.delete("/:id/connect", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.connect.cancel(id.value))
  })

  routes.delete("/:id", async (c) => {
    const id = validateId(c.req.param("id"))
    if (!id.ok) return render(c, id)
    return render(c, await deps.service.remove(id.value))
  })

  return routes
}
