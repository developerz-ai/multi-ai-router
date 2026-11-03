import type { ProviderId } from "@multi-ai-router/core"

/**
 * Vendor-priced offerings that have **no published model id**.
 *
 * A shipped price row is keyed by a model name (`rates.ts`), and a name is only allowed to appear
 * there when the vendor publishes it. Some vendors price an offering that has no id at all — a
 * *mode* of a model rather than a model — so there is nothing to key a row by. Those offerings are
 * recorded here instead: a record, not a price card.
 *
 * **No rate fields, deliberately.** A row of rates under a name nobody can request would be a rate
 * for nothing; a request naming one of these prices as unknown until an operator writes an
 * override, which is the truth: the router cannot route to an offering it cannot name.
 *
 * Blast radius of an entry here: none at runtime — this registry is read by tests and by whoever
 * writes an override. The risk it guards against is a *later* one: an entry that quietly becomes a
 * row, or a row that quietly appears for an id the vendor never published.
 */
export interface PricedOfferingWithoutPublishedId {
  /** The provider whose platform publishes the offering. */
  readonly provider: ProviderId
  /** The vendor's own name for the offering, as its pricing page states it. */
  readonly offering: string
  /** The vendor's published figure for the offering, as a short human string. */
  readonly publishedPrice: string
  /** Why no model id exists to key a shipped row by. */
  readonly reason: string
}

/**
 * The registry itself.
 *
 * Provenance: each vendor's published pricing page, read 2026-11-03. The Anthropic entries come
 * from the fast-mode price table on platform.claude.com/docs/en/about-claude/pricing and the
 * fast-mode page beside it.
 */
export const PRICED_OFFERINGS_WITHOUT_PUBLISHED_ID: readonly PricedOfferingWithoutPublishedId[] = [
  {
    provider: "anthropic-api",
    offering: "Claude Opus 5.5 fast mode",
    publishedPrice: "$8 / MTok input, $40 / MTok output",
    reason:
      'fast mode is a request flag (speed: "fast") on the ordinary claude-opus-5-5 id, not a separate model; Anthropic publishes no fast-mode model id to key a row by',
  },
  {
    provider: "anthropic-api",
    offering: "Claude Opus 5 fast mode",
    publishedPrice: "$10 / MTok input, $50 / MTok output",
    reason:
      'fast mode is a request flag (speed: "fast") on the ordinary claude-opus-5 id, not a separate model; Anthropic publishes no fast-mode model id to key a row by',
  },
  {
    provider: "anthropic-api",
    offering: "Claude Opus 4.8 fast mode",
    publishedPrice: "$10 / MTok input, $50 / MTok output",
    reason:
      'fast mode is a request flag (speed: "fast") on the ordinary claude-opus-4-8 id, not a separate model; Anthropic publishes no fast-mode model id to key a row by, and the mode is deprecated for removal on 2026-11-30',
  },
  {
    provider: "anthropic-api",
    offering: "Claude Mythos 5.1",
    publishedPrice: "$10 / MTok input, $50 / MTok output, cached read 0.025x ($0.25 / MTok)",
    reason:
      "the pricing page publishes Mythos 5.1's figure but no model id for it — the id appears in no catalog and on no context-window table — so there is no name to key a shipped row by",
  },
]
