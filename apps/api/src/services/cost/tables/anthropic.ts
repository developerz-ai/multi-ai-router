import type { ModelTable, RateCard } from "../rates"

/**
 * Anthropic's published per-Mtok API prices.
 *
 * Provenance: anthropic.com/pricing and the model reference, verified on the date
 * `PRICE_TABLE_AS_OF` names. Blast radius of a stale row: the metered total for `anthropic-api`
 * accounts and the notional total for Claude subscriptions, both of which name this file.
 *
 * A model missing here — an older snapshot family, a model released after this image was built —
 * prices as unknown on purpose. Inventing a rate puts a number nobody measured into a spend column.
 */

/**
 * Provenance: Anthropic publishes cache rates as multiples of a model's input rate — reads at 0.1x,
 * writes at 1.25x for the default 5-minute TTL (2x for the 1-hour TTL). They are derived here rather
 * than restated per row, because a restated multiple is a number that can drift from the one it was
 * derived from.
 *
 * A response never says which cache TTL was written, so the 5-minute default is assumed: a workload
 * built on 1-hour caching reads slightly low on cache writes, and is never over-reported.
 */
function anthropicRates(inputPerMtok: number, outputPerMtok: number): RateCard {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: inputPerMtok * 0.1,
    cacheWritePerMtok: inputPerMtok * 1.25,
  }
}

export const ANTHROPIC_MODELS: ModelTable = {
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
