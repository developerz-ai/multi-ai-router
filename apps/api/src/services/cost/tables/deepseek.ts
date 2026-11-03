import { type ModelTable, rates } from "../rates"

/**
 * DeepSeek's published per-Mtok prices (USD list).
 *
 * Provenance: api-docs.deepseek.com/quick_start/pricing, read 2026-11-03. Blast radius: the
 * metered total for `deepseek` accounts.
 *
 * DeepSeek quotes two input rates — cache hit and cache miss — which is the same split a
 * `UsageRecord` already carries: `tokensIn` is the uncached remainder (miss) and `cacheReadTokens`
 * is the hit (`services/usage/tokens.ts`).
 *
 * The page publishes **two bands**: a peak rate and an off-peak rate that is half of it. Peak hours
 * are 01:00–04:00 and 06:00–10:00 UTC on weekdays; everything else is off-peak. The **peak** rate
 * is what ships: it is the rate that always applies, so a request billed off-peak is over-reported
 * rather than a request billed at peak being under-reported. A table with no clock can only state
 * a standing rate, and the standing rate is the higher one.
 *
 * The CN platform publishes the same lineup in CNY; an account pointed there needs an override.
 */
export const DEEPSEEK_MODELS: ModelTable = {
  /** Flash — $0.30 / $1.20 at peak, cached read $0.006. */
  "deepseek-flash": rates(0.3, 1.2, { read: 0.006 }),
  /** Pro — $1.32 / $3.96 at peak, cached read $0.044. */
  "deepseek-v4-pro": rates(1.32, 3.96, { read: 0.044 }),
}
