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

/**
 * Both shapes carry one field neither ecosystem defines, on alias rows only: `resolved_model`, what
 * `sonnet` means today under this key. An extra field is what generated SDKs tolerate and what a
 * picker can use to collapse an alias onto the model it names; on a concrete id it is absent rather
 * than null, so a strict client sees exactly the documented shape.
 *
 * Both also say how big the model is, from the warm model catalog (never a query on this path):
 *
 * - **Anthropic** — `max_input_tokens` and `max_tokens`, Anthropic's own `ModelInfo` fields
 *   (@anthropic-ai/sdk 0.131 `resources/models.d.ts`), always present and `null` when unknown,
 *   exactly as that type declares. They are also the names Claude Code's model-capability readers
 *   parse from a `/v1/models` answer (docs/idea/03-providers.md).
 * - **OpenAI** — OpenAI's `Model` has no size field, so this follows the convention
 *   OpenAI-compatible listings settled on: `context_length` (OpenRouter, Together, Modal) and
 *   `max_completion_tokens` (the output cap under OpenAI's own request-parameter name, and
 *   OpenRouter's `top_provider` spelling). **Absent when unknown**, not null: with no documented
 *   field, a reader's schema is typically `optional(number)`, which a null fails.
 */
interface AnthropicModel {
  readonly type: "model"
  readonly id: string
  readonly display_name: string
  readonly max_input_tokens: number | null
  readonly max_tokens: number | null
  readonly resolved_model?: string
}

interface OpenAiModel {
  readonly id: string
  readonly object: "model"
  readonly created: number
  readonly owned_by: string
  readonly context_length?: number
  readonly max_completion_tokens?: number
  readonly resolved_model?: string
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
  return {
    type: "model",
    id: model.id,
    display_name: model.id,
    max_input_tokens: model.contextTokens,
    max_tokens: model.maxOutputTokens,
    ...resolution(model),
  }
}

function openAiModel(model: ReachableModel, created: number): OpenAiModel {
  return {
    id: model.id,
    object: "model",
    created,
    owned_by: model.owner,
    ...(model.contextTokens === null ? {} : { context_length: model.contextTokens }),
    ...(model.maxOutputTokens === null ? {} : { max_completion_tokens: model.maxOutputTokens }),
    ...resolution(model),
  }
}

function resolution(model: ReachableModel): { resolved_model?: string } {
  return model.resolvedModel === null ? {} : { resolved_model: model.resolvedModel }
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
