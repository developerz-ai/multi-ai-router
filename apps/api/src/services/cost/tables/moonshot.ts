import { type ModelTable, rates } from "../rates"

/**
 * Moonshot's published per-Mtok Kimi prices, international platform (USD).
 *
 * Provenance: platform.kimi.ai/docs/pricing, verified on the date `PRICE_TABLE_AS_OF` names. Blast
 * radius: the metered total for `kimi` accounts.
 *
 * The mainland platform (platform.moonshot.cn) publishes the same lineup **in CNY**. An account
 * pointed there through a base-URL override prices wrong against this table and should carry a
 * price override; converting a published CNY figure to USD here would invent a rate at a rate.
 *
 * Moonshot prices cache **hits** and **misses** as two input rates, which lines up exactly with how
 * a `UsageRecord` counts them: `tokensIn` is the uncached remainder (the miss price) and
 * `cacheReadTokens` is the hit (`services/usage/tokens.ts`).
 *
 * `kimi-k2`, `kimi-k2-turbo` and `kimi-latest` are **absent on purpose**: they are off the current
 * price list, and pricing a retired id against its last known rate is a guess about a bill nobody
 * is issuing. They report as unknown until a name that is priced comes back.
 */
export const MOONSHOT_MODELS: ModelTable = {
  /** The flagship, 1M context. */
  "kimi-k3": rates(3, 15, { read: 0.3 }),
  "kimi-k2.7-code": rates(0.95, 4, { read: 0.19 }),
  "kimi-k2.7-code-highspeed": rates(1.9, 8, { read: 0.38 }),
  "kimi-k2.6": rates(0.95, 4, { read: 0.16 }),
  "kimi-k2.5": rates(0.6, 3, { read: 0.1 }),

  /**
   * The `moonshot-v1` line, which has no cache tier at all and is scheduled for platform sunset.
   * Kept while it still bills: an account still pointed at one of these is still being charged.
   */
  "moonshot-v1-8k": rates(0.2, 2),
  "moonshot-v1-32k": rates(1, 3),
  "moonshot-v1-128k": rates(2, 5),
  "moonshot-v1-8k-vision-preview": rates(0.2, 2),
  "moonshot-v1-32k-vision-preview": rates(1, 3),
  "moonshot-v1-128k-vision-preview": rates(2, 5),
}
