import type { Context } from "hono"
import type { RouterKeyEnv } from "../../middleware/routerKeyAuth"
import { credentialStyle, type ReachableModel } from "../../services/dataplane"

/**
 * `GET /v1/models` is one path serving two ecosystems, and they expect different shapes. The path
 * itself says nothing (both dialects use it), so the response follows the **credential style the
 * client authenticated with**: `x-api-key` is how Anthropic-style clients present a key, bearer is
 * how OpenAI-style ones do. It is the only signal the request carries, and it is a reliable one —
 * a tool sends the header its own SDK sends.
 *
 * Both listings carry the same set: exactly the models reachable within the presenting key's
 * scope, named the way a client would ask for them.
 */

interface AnthropicModel {
  readonly type: "model"
  readonly id: string
  readonly display_name: string
}

interface OpenAiModel {
  readonly id: string
  readonly object: "model"
  readonly created: number
  readonly owned_by: string
}

export function renderModels(
  c: Context<RouterKeyEnv>,
  models: readonly ReachableModel[],
  now: Date,
): Response {
  const style = credentialStyle(c.req.header("x-api-key"))
  return style === "anthropic"
    ? c.json(anthropicList(models))
    : c.json(openAiList(models, Math.floor(now.getTime() / 1000)))
}

/** `GET /v1/models/:id` — the same per-dialect shape, unwrapped from the list envelope. */
export function renderModel(c: Context<RouterKeyEnv>, model: ReachableModel, now: Date): Response {
  const style = credentialStyle(c.req.header("x-api-key"))
  return style === "anthropic"
    ? c.json(anthropicModel(model))
    : c.json(openAiModel(model, Math.floor(now.getTime() / 1000)))
}

function anthropicModel(model: ReachableModel): AnthropicModel {
  return { type: "model", id: model.id, display_name: model.id }
}

function openAiModel(model: ReachableModel, created: number): OpenAiModel {
  return { id: model.id, object: "model", created, owned_by: model.owner }
}

function anthropicList(models: readonly ReachableModel[]): {
  data: readonly AnthropicModel[]
  has_more: false
  first_id: string | null
  last_id: string | null
} {
  const data = models.map(anthropicModel)
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  }
}

function openAiList(
  models: readonly ReachableModel[],
  created: number,
): { object: "list"; data: readonly OpenAiModel[] } {
  return {
    object: "list",
    data: models.map((model) => openAiModel(model, created)),
  }
}
