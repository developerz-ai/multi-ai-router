import type { ModelTable, RateCard } from "../rates"

/**
 * Anthropic's published per-Mtok API prices.
 *
 * Provenance: platform.claude.com/docs/en/about-claude/pricing ("Model pricing" table) and the
 * models overview beside it, verified on the date `PRICE_TABLE_AS_OF` names. Blast radius of a stale row: the metered total for `anthropic-api`
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
 * The read multiple stopped being one number with the 5.x refresh: the pricing page footnotes
 * Fable 5.1 at 0.025x and Opus 5.5 at 0.05x, "all other models use the standard 0.1x". So it is a
 * parameter, defaulted to the standard and stated only on the rows the vendor footnotes — the write
 * multiple is still 1.25x on every row.
 *
 * A response never says which cache TTL was written, so the 5-minute default is assumed: a workload
 * built on 1-hour caching reads slightly low on cache writes, and is never over-reported.
 */
function anthropicRates(
  inputPerMtok: number,
  outputPerMtok: number,
  cacheReadMultiple = 0.1,
): RateCard {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: inputPerMtok * cacheReadMultiple,
    cacheWritePerMtok: inputPerMtok * 1.25,
  }
}

/**
 * A **fast-mode** variant is priced by name, never by multiplying its base model.
 *
 * The multiplier is not a rule. Opus 4.7's fast variant bills at 6x its base ($30 / $150) and
 * Opus 4.8's and 5's at 2x ($10 / $50) — so a driver that derived "fast" from a base rate would
 * have over-reported one family by three times. Each row states the price its vendor publishes.
 */
export const ANTHROPIC_MODELS: ModelTable = {
  /**
   * Claude Opus 5.5 — $4 / $20, the current Opus tier and the first priced *below* its predecessor.
   * Cache reads are footnoted at 0.05x ($0.20), not the standard 0.1x.
   */
  "claude-opus-5-5": anthropicRates(4, 20, 0.05),
  /** Claude Opus 5 — $5 / $25. */
  "claude-opus-5": anthropicRates(5, 25),
  /** Claude Opus 5 fast mode — $10 / $50. See the note above: 2x here, 6x on 4.7. */
  "claude-opus-5-fast": anthropicRates(10, 50),
  /**
   * Claude Fable 5.1 — $10 / $50, the same card as Fable 5 except for cache reads, footnoted at
   * 0.025x ($0.25) where Fable 5 stays at the standard $1.
   */
  "claude-fable-5-1": anthropicRates(10, 50, 0.025),
  /** Claude Fable 5 — $10 in / $50 out. */
  "claude-fable-5": anthropicRates(10, 50),
  /** Claude Mythos 5 — the Project Glasswing twin of Fable 5, priced identically. */
  "claude-mythos-5": anthropicRates(10, 50),
  /** Claude Opus 4.8 — $5 / $25. */
  "claude-opus-4-8": anthropicRates(5, 25),
  /** Claude Opus 4.8 fast mode — $10 / $50. */
  "claude-opus-4-8-fast": anthropicRates(10, 50),
  /** Claude Opus 4.7 — $5 / $25. */
  "claude-opus-4-7": anthropicRates(5, 25),
  /** Claude Opus 4.7 fast mode — $30 / $150. Six times its base, not two. */
  "claude-opus-4-7-fast": anthropicRates(30, 150),
  /** Claude Opus 4.6 — $5 / $25. */
  "claude-opus-4-6": anthropicRates(5, 25),
  /** Claude Opus 4.5 — $5 / $25, where that tier's price was set. */
  "claude-opus-4-5": anthropicRates(5, 25),
  /** Claude Opus 4.1 — $15 / $75, the tier before the 4.5 reduction. */
  "claude-opus-4-1": anthropicRates(15, 75),
  /** Claude Opus 4 — $15 / $75. */
  "claude-opus-4": anthropicRates(15, 75),
  /** Claude Sonnet 5.5 — $2 / $10, the current Sonnet tier. */
  "claude-sonnet-5-5": anthropicRates(2, 10),
  /**
   * Claude Sonnet 5 — $2 / $10. Launched as introductory pricing through 2026-08-31 with $3 / $15
   * to follow; the pricing page now states the increase "will not occur" and $2 / $10 is the
   * standard price, so the row that used to carry the standing $3 / $15 was corrected with it.
   */
  "claude-sonnet-5": anthropicRates(2, 10),
  /** Claude Sonnet 4.6 — $3 / $15. */
  "claude-sonnet-4-6": anthropicRates(3, 15),
  /**
   * Claude Sonnet 4.5 — $3 / $15. Still published and still served, so a client asking for it is
   * priced. Nothing of the router's own depends on this row: the idle-account keepalive writes no
   * `UsageRecord`, so its turns are never priced whatever model it sends.
   */
  "claude-sonnet-4-5": anthropicRates(3, 15),
  /** Claude Sonnet 4 — $3 / $15. */
  "claude-sonnet-4": anthropicRates(3, 15),
  /** Claude Haiku 4.5 — $1 / $5. */
  "claude-haiku-4-5": anthropicRates(1, 5),
  /** Claude 3 Haiku — $0.25 / $1.25, still reachable and still the cheapest row here. */
  "claude-3-haiku": anthropicRates(0.25, 1.25),
}
