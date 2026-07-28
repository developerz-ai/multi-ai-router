import type { ContextTable } from "@multi-ai-router/core"

/**
 * Moonshot (Kimi) context windows.
 *
 * Provenance: Moonshot's published model reference, cross-checked against a live aggregator listing
 * on the date `CONTEXT_TABLE_AS_OF` names.
 *
 * Thinner than its neighbours on purpose. Moonshot names the same weights several ways — a
 * `-preview` pin, a `-turbo` serving tier, the `moonshot-v1-*` line whose id *is* its window — and
 * only the ids verifiable on that date are stated here. An id with no row prices its window as
 * unknown and renders as unknown, which is the honest answer; the alternative is a table that looks
 * complete and is quietly wrong about the pins.
 */
export const MOONSHOT_WINDOWS: ContextTable = {
  "kimi-k3": { contextTokens: 1_048_576 },
  "kimi-k2.7-code": { contextTokens: 262_144, maxOutputTokens: 262_144 },
  "kimi-k2.6": { contextTokens: 262_144, maxOutputTokens: 262_144 },
  "kimi-k2.5": { contextTokens: 262_144, maxOutputTokens: 262_144 },
  "kimi-k2-thinking": { contextTokens: 262_144, maxOutputTokens: 100_352 },
  "kimi-k2-0905": { contextTokens: 262_144, maxOutputTokens: 100_352 },
  /** The original k2 release, at half the window its successors carry. */
  "kimi-k2": { contextTokens: 131_072, maxOutputTokens: 100_352 },

  /**
   * The `moonshot-v1-*` line states its window in its own name, and these rows exist so the catalog
   * agrees with the id rather than leaving a model whose size is written on the tin as unknown.
   */
  "moonshot-v1-128k": { contextTokens: 131_072 },
  "moonshot-v1-32k": { contextTokens: 32_768 },
  "moonshot-v1-8k": { contextTokens: 8_192 },
}
