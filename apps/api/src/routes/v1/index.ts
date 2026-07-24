import type { Dialect } from "@multi-ai-router/core"
import { Hono } from "hono"
import { type RouterKeyEnv, routerKeyAuth } from "../../middleware/routerKeyAuth"
import type {
  Dispatcher,
  HealthStore,
  RouterKeyVerifier,
  RoutingCatalog,
} from "../../services/dataplane"
import { reachableModels } from "../../services/dataplane"
import { renderModels } from "./models"

/**
 * The data-plane ingress surface — the four routes a client actually talks to
 * (docs/idea/06-protocol-translation.md#ingress-surface):
 *
 * | Path | Dialect |
 * |---|---|
 * | `POST /v1/messages` | Anthropic Messages |
 * | `POST /v1/chat/completions` | OpenAI Chat Completions |
 * | `POST /v1/responses` | OpenAI Responses |
 * | `GET /v1/models` | the models reachable by the presenting key |
 *
 * **Both OpenAI paths are first-class, and that is not redundancy.** `/v1/responses` is where new
 * clients are going; `/v1/chat/completions` is what the installed base sends today. Neither is
 * deprecated.
 *
 * Thin, as the conventions require: a handler names its ingress dialect and calls one service. The
 * dialect is fixed **per path** and never sniffed from a body — the path is the contract.
 * Everything else (routing, credentials, failover, relay, accounting) lives in
 * `services/dataplane/`.
 *
 * Mountable on its own: `app.route("/", dataPlaneRoutes(deps))`. Paths here are absolute.
 */

export interface DataPlaneRoutesDeps {
  readonly verifier: RouterKeyVerifier
  readonly dispatcher: Dispatcher
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly now?: () => Date
}

/** Where these routes mount. Absolute paths, so the mount point is the root. */
export const DATA_PLANE_BASE_PATH = "/"

const INGRESS: readonly (readonly [string, Dialect])[] = [
  ["/v1/messages", "anthropic"],
  ["/v1/chat/completions", "openai-chat"],
  ["/v1/responses", "openai-responses"],
]

export function dataPlaneRoutes(deps: DataPlaneRoutesDeps): Hono<RouterKeyEnv> {
  const routes = new Hono<RouterKeyEnv>()
  const guard = routerKeyAuth(deps.verifier)
  const now = deps.now ?? (() => new Date())

  for (const [path, ingress] of INGRESS) {
    routes.post(path, guard, (c) =>
      deps.dispatcher.dispatch({
        ingress,
        request: c.req.raw,
        key: c.get("routerKey"),
        requestId: c.get("requestId"),
      }),
    )
  }

  routes.get("/v1/models", guard, (c) =>
    renderModels(c, reachableModels(deps.catalog, deps.health, c.get("routerKey"), now()), now()),
  )

  return routes
}
