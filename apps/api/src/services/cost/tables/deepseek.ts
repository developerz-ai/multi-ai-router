import { type ModelTable, rates } from "../rates"

/**
 * DeepSeek's published per-Mtok prices (USD list).
 *
 * Provenance: api-docs.deepseek.com/quick_start/pricing, verified on the date `PRICE_TABLE_AS_OF`
 * names. Blast radius: the metered total for `deepseek` accounts.
 *
 * DeepSeek quotes two input rates — cache hit and cache miss — which is the same split a
 * `UsageRecord` already carries: `tokensIn` is the uncached remainder (miss) and `cacheReadTokens`
 * is the hit (`services/usage/tokens.ts`).
 *
 * The off-peak discount window is gone from both the EN and CN price pages, and with it the one
 * reason this table would have needed a clock.
 *
 * `deepseek-chat` and `deepseek-reasoner` are absent: discontinued at the end of the announced
 * wind-down, and pricing a dead id at its last rate would report a charge nobody is issuing.
 * The CN platform publishes the same lineup in CNY; an account pointed there needs an override.
 */
export const DEEPSEEK_MODELS: ModelTable = {
  "deepseek-v4-flash": rates(0.14, 0.28, { read: 0.0028 }),
  "deepseek-v4-pro": rates(0.435, 0.87, { read: 0.003625 }),
}
