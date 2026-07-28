import { ProviderId } from "@multi-ai-router/core"
import { type ModelRates, type ModelTable, modelLookupKeys, type ShippedRate } from "./rates"
import { ANTHROPIC_MODELS } from "./tables/anthropic"
import { CEREBRAS_MODELS } from "./tables/cerebras"
import { DEEPSEEK_MODELS } from "./tables/deepseek"
import { GOOGLE_MODELS } from "./tables/google"
import { GROQ_MODELS } from "./tables/groq"
import { MINIMAX_MODELS } from "./tables/minimax"
import { MISTRAL_MODELS } from "./tables/mistral"
import { MOONSHOT_MODELS } from "./tables/moonshot"
import { OPENAI_MODELS } from "./tables/openai"
import { TOGETHER_MODELS } from "./tables/together"
import { XAI_MODELS } from "./tables/xai"
import { ZAI_MODELS } from "./tables/zai"

/**
 * The price table shipped with the image: which vendor table answers for which provider.
 *
 * Keyed by `provider + model`, per million tokens, in US dollars — the same model name costs
 * different money on different upstreams, and an aggregator or a self-hosted endpoint has no
 * published price at all. A provider or a model absent from this table is **unknown**, and unknown
 * is reported as NULL rather than as zero (docs/idea/08-observability.md#cost-estimation): a zero in
 * a spend column is the claim that a request was free.
 *
 * Blast radius of a wrong number here: one cost line in a report. Nothing about pricing reaches
 * routing, a response, or a model choice — the client picks the model, always.
 *
 * Operator-editable overrides layer *over* this table rather than replacing it (`book.ts`): an
 * override wins for the provider + model it names, and every other model keeps the shipped number.
 * A deployment correcting one stale price must not lose the rest of the table to do it.
 */

/**
 * The day every row in `tables/` was checked against its vendor's own published price.
 *
 * A price table with no date is a table nobody can judge. This one is shipped in an image, vendors
 * reprice without asking, and the honest reading of a cost column is "correct as of this date, to
 * the extent the operator has not overridden it" — so the date travels with the numbers: to
 * `GET /api/admin/settings` for the console, and to `router_price_table_asof_timestamp_seconds`
 * for an alert that fires when it has aged past what a deployment tolerates.
 *
 * Update it in the same commit as any edit under `tables/`, and never without one.
 */
export const PRICE_TABLE_AS_OF = "2026-07-28"

/**
 * Only providers with a published, model-keyed price list appear here.
 *
 * `anthropic-oauth` shares the Anthropic API table and `openai-oauth` shares the OpenAI one
 * deliberately: a subscription has no per-token price, so those rows are valued at what the same
 * tokens would have cost on that vendor's API and marked `notional` — see `estimateCost`.
 *
 * Four providers are absent and stay absent, because for each of them a shipped number would be a
 * fiction rather than a stale fact:
 *
 * - `openrouter` — the price is whichever upstream it routed to, decided per request. It reports
 *   the figure itself in the response body; reading that is a separate change, and inventing a
 *   table meanwhile would price every route as one.
 * - `ollama` — the operator's own hardware. There is no per-token price to state, and `0` would
 *   claim electricity is free rather than that nobody billed for tokens.
 * - `openai-compatible` / `anthropic-compatible` — the operator's own contract with whatever is
 *   behind the base URL they supplied. Only they know the rate, which is what price overrides are
 *   for.
 */
const PRICES: Partial<Record<ProviderId, ModelTable>> = {
  "anthropic-api": ANTHROPIC_MODELS,
  "anthropic-oauth": ANTHROPIC_MODELS,
  "openai-api": OPENAI_MODELS,
  "openai-oauth": OPENAI_MODELS,
  gemini: GOOGLE_MODELS,
  zai: ZAI_MODELS,
  kimi: MOONSHOT_MODELS,
  minimax: MINIMAX_MODELS,
  groq: GROQ_MODELS,
  deepseek: DEEPSEEK_MODELS,
  xai: XAI_MODELS,
  mistral: MISTRAL_MODELS,
  together: TOGETHER_MODELS,
  cerebras: CEREBRAS_MODELS,
}

/** The rates for one upstream model, or null when this image ships no price for it. */
export function lookupRates(provider: ProviderId, model: string): ModelRates | null {
  const table = PRICES[provider]
  if (table === undefined) return null
  const [name, family] = modelLookupKeys(model)
  return table[name] ?? table[family] ?? null
}

/**
 * Every shipped row, provider then model, so the settings screen can render the table it is
 * overriding. Sorted rather than emitted in declaration order: a list an operator reads against
 * their own edits must not reshuffle because a row moved in a table file.
 *
 * A model with a long-context tier emits **two** rows under the same name, the standard one first
 * and the tiered one carrying the prompt size it starts at. Flat rather than nested, because that
 * is how it renders beside an override — and an override is deliberately flat: one written for a
 * tiered model replaces both tiers, which is the operator saying "this is the rate, whatever the
 * prompt".
 */
export function listShippedRates(): readonly ShippedRate[] {
  const rows: ShippedRate[] = []
  // Driven off core's id list rather than the table's own keys: `Object.keys` on a partial record
  // is `string[]`, and narrowing it back would be an assertion nobody checks.
  for (const provider of ProviderId.options) {
    const table = PRICES[provider]
    if (table === undefined) continue
    for (const [model, rates] of Object.entries(table)) {
      const { longContext, ...standard } = rates
      rows.push({ provider, model, ...standard })
      if (longContext !== undefined) rows.push({ provider, model, ...longContext })
    }
  }
  return rows.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      (a.fromPromptTokens ?? 0) - (b.fromPromptTokens ?? 0),
  )
}
