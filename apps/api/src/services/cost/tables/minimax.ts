import { type ModelTable, rates, tiered } from "../rates"

/**
 * MiniMax's published per-Mtok prices, international platform (USD), **standard service tier**.
 *
 * Provenance: platform.minimax.io/docs/guides/pricing-paygo, verified on the date
 * `PRICE_TABLE_AS_OF` names. Blast radius: the metered total for `minimax` accounts.
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
 * `MiniMax-M1` and the `abab-*` line are absent: off the current price list, and a retired id
 * priced at its last known rate is a guess about a bill nobody is issuing.
 */

/** M3 switches to its long rate once the prompt passes 512k. */
const M3_LONG_CONTEXT_FROM = 512_000

export const MINIMAX_MODELS: ModelTable = {
  "minimax-m3": tiered(
    rates(0.3, 1.2, { read: 0.06 }),
    M3_LONG_CONTEXT_FROM,
    rates(0.6, 2.4, { read: 0.12 }),
  ),
  "minimax-m2.7": rates(0.3, 1.2, { read: 0.06, write: 0.375 }),
  "minimax-m2.7-highspeed": rates(0.6, 2.4, { read: 0.06, write: 0.375 }),
  "minimax-m2.5": rates(0.3, 1.2, { read: 0.03, write: 0.375 }),
  "minimax-m2.1": rates(0.3, 1.2, { read: 0.03, write: 0.375 }),
  "minimax-m2": rates(0.3, 1.2, { read: 0.03, write: 0.375 }),
}
