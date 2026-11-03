import { type ModelTable, rates } from "../rates"

/**
 * USD API-equivalent attribution for subscription coding, not a membership invoice.
 *
 * Identity: https://www.kimi.com/code/docs/en/ (read 2026-11-03) — the six model ids the coding
 * protocols accept, and which platform model each one is.
 * Reference prices: https://platform.kimi.ai/docs/pricing/chat (read 2026-11-03).
 *
 * `k3-256k` has the same K3 identity within 256K; membership quota multipliers are not prices.
 * `kimi-for-coding` is K2.8 Preview and has no verified platform rate. Extra Usage is RMB and only
 * described as close to platform prices. Neither may silently inherit a USD metered rate.
 * K3 cache writes require TTL evidence absent from these usage counters; lookup rejects them.
 */
export const KIMI_CODING_REFERENCES: ModelTable = {
  /** K3.1 Pro — the platform's `kimi-k3.1-pro`: $2 / $10, cached read $0.20. */
  "k3.1-pro": rates(2, 10, { read: 0.2 }),
  /** K3.1 Pro Highspeed — the platform's `kimi-k3.1-pro-highspeed`: $4 / $20, cached read $0.20. */
  "k3.1-pro-highspeed": rates(4, 20, { read: 0.2 }),
  k3: rates(3, 15, { read: 0.3 }),
  "k3-256k": rates(3, 15, { read: 0.3 }),
  "kimi-for-coding-highspeed": rates(1.9, 8, { read: 0.38 }),
}
