import type { Dialect } from "@multi-ai-router/core"
import { Hono } from "hono"
import { type RouterKeyEnv, routerKeyAuth } from "../../middleware/routerKeyAuth"
import type {
  Dispatcher,
  HealthStore,
  RouterKeyVerifier,
  RoutingCatalog,
  UpstreamOperation,
} from "../../services/dataplane"
import { reachableModel, reachableModels } from "../../services/dataplane"
import { renderModel, renderModels } from "./models"

/**
 * The data-plane ingress surface — the six routes a client actually talks to
 * (docs/idea/06-protocol-translation.md#ingress-surface):
 *
 * | Path | Dialect | Operation |
 * |---|---|---|
 * | `POST /v1/messages` | Anthropic Messages | inference |
 * | `POST /v1/messages/count_tokens` | Anthropic Messages | count tokens |
 * | `POST /v1/chat/completions` | OpenAI Chat Completions | inference |
 * | `POST /v1/responses` | OpenAI Responses | inference |
 * | `POST /v1/embeddings` | OpenAI | embed |
 * | `GET /v1/models` | the models reachable by the presenting key | — |
 * | `GET /v1/models/:id` | one model, `404` if the presenting key cannot reach it | — |
 *
 * **Both OpenAI paths are first-class, and that is not redundancy.** `/v1/responses` is where new
 * clients are going; `/v1/chat/completions` is what the installed base sends today. Neither is
 * deprecated.
 *
 * The two non-completion paths are on the list because real clients call them and a router that
 * 404s either half-works against those clients. Claude Code calls `count_tokens` unprompted, before
 * a turn, to decide when to compact its context; every RAG toolchain — LangChain, LlamaIndex,
 * Continue.dev — calls `embeddings` beside its chat traffic, and pointing one of them at a second
 * base URL to get it defeats the point of pooling credentials behind one endpoint.
 *
 * Both take the same key, the same scope intersection, and the same failover chain as inference;
 * only the operation differs, and only accounts that can answer it are planned
 * (`services/dataplane/egress/mode.ts`).
 *
 * `/v1/embeddings` names `openai-chat` as its ingress dialect for the error shape alone — an
 * embeddings body is dialect-neutral within the OpenAI family, and the egress gate treats both
 * OpenAI surfaces as one.
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

interface IngressRoute {
  readonly path: string
  readonly dialect: Dialect
  /** Omitted is inference, which is what every path but the token count and the embedding performs. */
  readonly operation?: UpstreamOperation
}

const INGRESS: readonly IngressRoute[] = [
  { path: "/v1/messages", dialect: "anthropic" },
  { path: "/v1/messages/count_tokens", dialect: "anthropic", operation: "count-tokens" },
  { path: "/v1/chat/completions", dialect: "openai-chat" },
  { path: "/v1/responses", dialect: "openai-responses" },
  { path: "/v1/embeddings", dialect: "openai-chat", operation: "embeddings" },
]

export function dataPlaneRoutes(deps: DataPlaneRoutesDeps): Hono<RouterKeyEnv> {
  const routes = new Hono<RouterKeyEnv>()
  const guard = routerKeyAuth(deps.verifier)
  const now = deps.now ?? (() => new Date())

  for (const route of INGRESS) {
    routes.post(route.path, guard, (c) =>
      deps.dispatcher.dispatch({
        ingress: route.dialect,
        ...(route.operation === undefined ? {} : { operation: route.operation }),
        request: c.req.raw,
        key: c.get("routerKey"),
        requestId: c.get("requestId"),
      }),
    )
  }

  routes.get("/v1/models", guard, (c) =>
    renderModels(c, reachableModels(deps.catalog, deps.health, c.get("routerKey"), now()), now()),
  )

  // Throws `ModelNotFoundError` (404) when the presenting key's scope can't reach the id; the
  // error handler renders it in the client's dialect same as any other thrown `RouterError`.
  routes.get("/v1/models/:id", guard, (c) => {
    const at = now()
    const model = reachableModel(
      deps.catalog,
      deps.health,
      c.get("routerKey"),
      c.req.param("id"),
      at,
    )
    return renderModel(c, model, at)
  })

  return routes
}
