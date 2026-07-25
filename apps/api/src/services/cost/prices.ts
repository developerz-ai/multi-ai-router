import type { ProviderId } from "@multi-ai-router/core"

/**
 * The price table shipped with the image.
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
 * The operator-editable override is deferred. When it lands it layers over this table; the shipped
 * numbers stay the fallback rather than being replaced.
 */

export interface ModelRates {
  readonly inputPerMtok: number
  readonly outputPerMtok: number
  readonly cacheReadPerMtok: number
  readonly cacheWritePerMtok: number
}

/**
 * Provenance: Anthropic publishes cache rates as multiples of a model's input rate — reads at 0.1x,
 * writes at 1.25x for the default 5-minute TTL (2x for the 1-hour TTL). They are derived here rather
 * than restated per row, because a restated multiple is a number that can drift from the one it was
 * derived from.
 *
 * A response never says which cache TTL was written, so the 5-minute default is assumed: a workload
 * built on 1-hour caching reads slightly low on cache writes, and is never over-reported.
 */
function anthropicRates(inputPerMtok: number, outputPerMtok: number): ModelRates {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: inputPerMtok * 0.1,
    cacheWritePerMtok: inputPerMtok * 1.25,
  }
}

/**
 * Provenance: Anthropic's published per-Mtok API prices for the current model families. Blast radius
 * of a stale row: the metered total for `anthropic-api` accounts and the notional total for Claude
 * subscriptions, both of which name this file as their source.
 *
 * A model missing here — an older snapshot family, a model released after this image was built —
 * prices as unknown on purpose. Inventing a rate puts a number nobody measured into a spend column.
 */
const ANTHROPIC_MODELS: Readonly<Record<string, ModelRates>> = {
  /** Claude Fable 5 — $10 in / $50 out. */
  "claude-fable-5": anthropicRates(10, 50),
  /** Claude Mythos 5 — the Project Glasswing twin of Fable 5, priced identically. */
  "claude-mythos-5": anthropicRates(10, 50),
  /** Claude Opus 4.8 — $5 / $25, the whole current Opus tier. */
  "claude-opus-4-8": anthropicRates(5, 25),
  /** Claude Opus 4.7 — $5 / $25. */
  "claude-opus-4-7": anthropicRates(5, 25),
  /** Claude Opus 4.6 — $5 / $25. */
  "claude-opus-4-6": anthropicRates(5, 25),
  /**
   * Claude Sonnet 5 — $3 / $15. The introductory $2 / $10 is date-bounded, and the standing rate is
   * the only one a table with no clock can state; an intro window reads high, never low.
   */
  "claude-sonnet-5": anthropicRates(3, 15),
  /** Claude Sonnet 4.6 — $3 / $15. */
  "claude-sonnet-4-6": anthropicRates(3, 15),
  /** Claude Haiku 4.5 — $1 / $5. */
  "claude-haiku-4-5": anthropicRates(1, 5),
}

/**
 * Only providers with a published, model-keyed price list appear here.
 *
 * `anthropic-oauth` (Claude Max/Pro) shares the API table deliberately: a subscription has no
 * per-token price, so those rows are valued at what the same tokens would have cost on the API and
 * marked `notional` — see `estimateCost`. z.ai, Kimi, and MiniMax bill their own model ids,
 * OpenRouter's price depends on the route it picked, and the `*-compatible` endpoints are the
 * operator's own contract: none of the four can be priced from a table shipped in this image.
 */
const PRICES: Partial<Record<ProviderId, Readonly<Record<string, ModelRates>>>> = {
  "anthropic-api": ANTHROPIC_MODELS,
  "anthropic-oauth": ANTHROPIC_MODELS,
}

/**
 * A dated snapshot bills at its family's published rate, so `claude-haiku-4-5-20251001` prices as
 * `claude-haiku-4-5`. Stripping the date is not a guess — it is how the provider prices the pin.
 */
const SNAPSHOT_SUFFIX = /-\d{8}$/

/** The rates for one upstream model, or null when this image ships no price for it. */
export function lookupRates(provider: ProviderId, model: string): ModelRates | null {
  const table = PRICES[provider]
  if (table === undefined) return null
  const name = model.trim().toLowerCase()
  return table[name] ?? table[name.replace(SNAPSHOT_SUFFIX, "")] ?? null
}
