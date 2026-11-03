import { type ModelTable, rates, tiered } from "../rates"

/**
 * MiniMax's published per-Mtok prices, international platform (USD), **standard service tier**.
 *
 * Provenance: platform.minimax.io/docs/pricing/overview, read 2026-11-03. Blast radius: the metered
 * total for `minimax` accounts.
 *
 * Two things this table deliberately does not chase:
 *
 * - **`service_tier: priority`**, which bills at 1.5x. A per-request choice the client makes and
 *   nothing in a response repeats, so every row here is the standard tier and a deployment that
 *   sends priority traffic reads low. An override is the fix.
 * - **The mainland platform's CNY list** (platform.minimaxi.com), which is a different deployment.
 *
 * M3's headline rate is a standing 50% discount off list rather than a promotion with an end date,
 * so the discounted figure is the one shipped: it is what an invoice says today, and a table with
 * no clock can only state a standing rate.
 *
 * The **M2 line and the `abab-*` line are absent**: they are off the current price list, and a
 * retired id priced at its last known rate is a guess about a bill nobody is issuing.
 */
export const MINIMAX_MODELS: ModelTable = {
  /**
   * MiniMax-M3.1-Flash — $0.15 / $0.60, cached read $0.015. One price whatever the prompt.
   */
  "minimax-m3.1-flash": rates(0.15, 0.6, { read: 0.015 }),
  /** MiniMax-M3 switches to its long rate once the prompt passes 512k. */
  "minimax-m3": tiered(rates(0.3, 1.2, { read: 0.06 }), 512_000, rates(0.6, 2.4, { read: 0.12 })),
}
