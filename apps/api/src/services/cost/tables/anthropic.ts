import type { ModelTable, RateCard } from "../rates"

/**
 * Anthropic's published per-Mtok API prices.
 *
 * Provenance: platform.claude.com/docs/en/about-claude/pricing ("Model pricing" table), the
 * fast-mode page beside it, and the models overview, all read 2026-11-03. Blast radius of a stale
 * row: the metered total for `anthropic-api` accounts and the notional total for Claude
 * subscriptions, both of which name this file.
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
 * Fable 5.1 at 0.025x, and Opus 5.5 and Sonnet 5.5 at 0.05x, "all other models use the standard
 * 0.1x". So it is a parameter, defaulted to the standard and stated only on the rows the vendor
 * footnotes — the write multiple is still 1.25x on every row.
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
    // Rounded to four places: `3 * 0.1` is 0.30000000000000004 in binary floating point, and a
    // spend column that carries the binary error of a multiplication is a number nobody can
    // reconcile against the published figure it came from. Four places is enough for every
    // published Anthropic figure, including the $0.025 and $0.3125 on Claude 3 Haiku.
    cacheReadPerMtok: Math.round(inputPerMtok * cacheReadMultiple * 10_000) / 10_000,
    cacheWritePerMtok: Math.round(inputPerMtok * 1.25 * 10_000) / 10_000,
  }
}

/**
 * **Fast mode is not a model id, so it has no row here.**
 *
 * Anthropic's fast mode is a request flag — `speed: "fast"` on the Messages API, `speed` on an
 * agent's model object — on the *same* model id, not a separate one. The pricing page's fast-mode
 * table therefore names the ordinary models beside their fast rates: Opus 5.5 at $8 / $40, Opus 5
 * and Opus 4.8 at $10 / $50.
 *
 * Two consequences, both load-bearing:
 *
 * - There is no published id `claude-opus-5-5-fast`, `claude-opus-5-fast` or
 *   `claude-opus-4-8-fast`, so a row under any of those names would price a name Anthropic does
 *   not serve. A client asking for one prices as unknown, which is the truth: the fast *rate* is
 *   reachable, but only under the base id and only with the flag the router does not send.
 * - **Opus 4.7 has no fast mode at all.** The fast-mode page lists fast mode for Opus 5.5, Opus 5
 *   and Opus 4.8 only, and the page says so explicitly. The row this table used to carry for it —
 *   $30 / $150, six times its base — is a figure Anthropic never published for any model, which is
 *   how a wrong number survives: it looks like a rate someone else would have written down.
 *
 * A fast rate is therefore never derived from a base rate here. The published fast figures are
 * recorded in `offerings.ts` as vendor-priced offerings with no published model id, where a reader
 *  can see the number without the table asserting an id that does not exist.
 *
 * The same holds for **Mythos 5.1**: the pricing page publishes its figure ($10 / $50, cached read
 * 0.025x / $0.25) but publishes no model id for it, so it is a registry entry in `offerings.ts`
 *  rather than a row here. A request naming `claude-mythos-5-1` prices as unknown, which is the
 *  truth: the router cannot route to an offering it cannot name.
 */
export const ANTHROPIC_MODELS: ModelTable = {
  /**
   * Claude Opus 5.5 — $4 / $20, the current Opus tier and the first priced *below* its predecessor.
   * Cache reads are footnoted at 0.05x ($0.20), not the standard 0.1x.
   */
  "claude-opus-5-5": anthropicRates(4, 20, 0.05),
  /** Claude Opus 5 — $5 / $25. */
  "claude-opus-5": anthropicRates(5, 25),
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
  /** Claude Opus 4.7 — $5 / $25. */
  "claude-opus-4-7": anthropicRates(5, 25),
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
