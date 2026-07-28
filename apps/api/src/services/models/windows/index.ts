import type { ContextTable, ContextWindow, ProviderId } from "@multi-ai-router/core"
import { modelLookupKeys } from "../../cost"
import { ANTHROPIC_WINDOWS } from "./anthropic"
import { MINIMAX_WINDOWS } from "./minimax"
import { DEEPSEEK_WINDOWS, XAI_WINDOWS } from "./misc"
import { MOONSHOT_WINDOWS } from "./moonshot"
import { OPENAI_WINDOWS } from "./openai"
import { ZAI_WINDOWS } from "./zai"

/**
 * The context-window table shipped with the image: which vendor table answers for which provider.
 *
 * The exact structural twin of `cost/prices.ts`, on purpose — same partial record keyed by
 * `ProviderId`, same `modelLookupKeys` normalization, same rule that an absent row is **unknown**
 * rather than a default. Cost and context are two facts about the same model published by the same
 * vendor page, and answering them two different ways would be one more thing to keep in step.
 *
 * A provider appears here only if its own listing states no size. That is the entry condition, and
 * it is why several providers with drivers are absent:
 *
 * - `gemini` and `mistral` — their listings carry `inputTokenLimit`/`outputTokenLimit` and
 *   `max_context_length`, so the parser reads a **live** number per account and a shipped row would
 *   only be a staler copy of it.
 * - `groq`, `together`, `cerebras` — the same: these hosts publish `context_window` /
 *   `context_length` beside each model they serve.
 * - `openrouter` — states `context_length` per model, and is not swept at all besides.
 * - `ollama`, `openai-compatible`, `anthropic-compatible` — whatever the operator pointed them at.
 *   A shipped window for an endpoint this router has never seen would be a fiction, not a fact.
 */

/**
 * The day every row under `windows/` was checked against its vendor's published reference.
 *
 * Travels with the numbers for the same reason `PRICE_TABLE_AS_OF` does: a shipped constant that
 * cannot age visibly is one a reader has no way to judge. Update it in the same commit as any edit
 * under `windows/`, and never without one.
 */
export const CONTEXT_TABLE_AS_OF = "2026-07-28"

const WINDOWS: Partial<Record<ProviderId, ContextTable>> = {
  "anthropic-api": ANTHROPIC_WINDOWS,
  // A subscription serves the same models as the API and they are the same size. Unlike price —
  // where the shared table is an *attribution* — this is simply the same fact.
  "anthropic-oauth": ANTHROPIC_WINDOWS,
  "openai-api": OPENAI_WINDOWS,
  "openai-oauth": OPENAI_WINDOWS,
  zai: ZAI_WINDOWS,
  kimi: MOONSHOT_WINDOWS,
  minimax: MINIMAX_WINDOWS,
  deepseek: DEEPSEEK_WINDOWS,
  xai: XAI_WINDOWS,
}

/** The shipped window for one upstream model, or null when this image states none. */
export function lookupContextWindow(provider: ProviderId, model: string): ContextWindow | null {
  const table = WINDOWS[provider]
  if (table === undefined) return null
  const [name, family] = modelLookupKeys(model)
  return table[name] ?? table[family] ?? null
}
