import type { ProviderId } from "@multi-ai-router/core"

/**
 * **The free models worth using, smartest first.** The order is the ranking: a client walking
 * `GET /v1/free-models` tries row one before row two.
 *
 * A table rather than a computed score, because the judgement has no formula: an intelligence index
 * says nothing about a model whose host refuses most requests, and half the rows have no index. It
 * is re-ranked weekly by `.dz/schedules/free-providers.md`, which owns the order and cites its evidence.
 *
 * A row says where a model is free **by id**: the same weights are free under one provider's id and
 * billed under another's, so an id is listed only for a provider that never bills it. That is why
 * `groq` and `gemini` are absent: whether their ids cost anything is the account's plan, and a row
 * that called a metered key's traffic free would be a lie with a price on it.
 *
 * This ranks what is offered; it never routes. The client still picks the model (non-negotiable 4).
 */
export interface FreeModelRow {
  /** The model's bare name, for a reader. Never sent upstream. */
  readonly name: string
  /** Artificial Analysis Intelligence Index, or null where none is published. */
  readonly intelligenceIndex: number | null
  readonly ids: Partial<Record<ProviderId, readonly string[]>>
}

/** The day the order below was last judged. Travels with the listing, so an old ranking shows its age. */
export const FREE_RANKING_AS_OF = "2026-11-23"

/** On OpenRouter and Kilo alike: one id, two sources. */
const both = (id: string): FreeModelRow["ids"] => ({ openrouter: [id], kilo: [id] })

/**
 * Provenance: index v5.0.1 as read by mvalentsev/awesome-free-ai-coding, 2026-11-23; ids from each
 * provider's own `GET /models` that day, and every `nvidia` and `openai-compatible` id answered a
 * forced tool call with a real key. The `openai-compatible` ids are Token Harbor's
 * (`free-presets.ts`); a preset nobody has called with a key is offered but not ranked.
 * Left out on that evidence: AIHubMix (ten calls ever, then a `200` whose text is a refusal), and
 * NVIDIA's `minimax-m3.1-flash` and `glm-5.3-flash` (no answer in 90 s, three tries).
 * DeepSeek V4.1 Flash is placed by the paid traffic this router gives it.
 * Unscored rows are placed on this router's own success rate over the 14 days to 2026-11-23: ERNIE
 * 88%, Particle 63%, Ling 16%, which is why Ling is last despite the largest window.
 */
export const FREE_MODEL_RANKING: readonly FreeModelRow[] = [
  {
    name: "deepseek-v4.1-flash",
    intelligenceIndex: null,
    ids: { "openai-compatible": ["deepseek-v4.1-flash:free"] },
  },
  {
    name: "step-5-preview",
    intelligenceIndex: 28.5,
    ids: { nvidia: ["stepfun-ai/step-5-preview"] },
  },
  {
    name: "mimo-v2.6-flash",
    intelligenceIndex: 26.7,
    ids: { "openai-compatible": ["mimo-v2.6-flash:free"] },
  },
  {
    name: "nemotron-3.5-super-vl",
    intelligenceIndex: 13.6,
    ids: {
      ...both("nvidia/nemotron-3.5-super-vl:free"),
      nvidia: ["nvidia/nemotron-3.5-super-vl-120b-a12b"],
    },
  },
  {
    name: "nemotron-3-ultra",
    intelligenceIndex: 11.8,
    ids: {
      ...both("nvidia/nemotron-3-ultra-550b-a55b:free"),
      nvidia: ["nvidia/nemotron-3-ultra-550b-a55b"],
    },
  },
  {
    name: "ernie-5.5-flash-preview",
    intelligenceIndex: null,
    ids: both("baidu/ernie-5.5-flash-preview:free"),
  },
  { name: "beam-1.0", intelligenceIndex: null, ids: { kilo: ["reflection/beam-free"] } },
  { name: "flint-v1.0", intelligenceIndex: null, ids: both("recursive/flint-v1.0:free") },
  {
    name: "dots-3-note-preview",
    intelligenceIndex: null,
    ids: both("dots-studio/dots-3-note-preview:free"),
  },
  {
    name: "nemotron-3.5-lightning",
    intelligenceIndex: 5.5,
    ids: {
      ...both("nvidia/nemotron-3.5-lightning:free"),
      nvidia: ["nvidia/nemotron-3.5-lightning-30b-a3b"],
    },
  },
  { name: "particle-1", intelligenceIndex: null, ids: both("particle-ai/particle-1:free") },
  { name: "ling-3.2-flash", intelligenceIndex: null, ids: both("inclusionai/ling-3.2-flash:free") },
]

/** Whether this row says `provider` serves `id` for nothing. */
export function ownsFreeId(row: FreeModelRow, provider: ProviderId, id: string): boolean {
  return row.ids[provider]?.includes(id) === true
}
