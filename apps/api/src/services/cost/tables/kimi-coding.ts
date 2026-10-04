import { type ModelTable, rates } from "../rates"

/**
 * USD API-equivalent attribution for subscription coding, not a membership invoice.
 * Identity: https://www.kimi.com/code/docs/en/ (2026-10-03).
 * Reference prices: https://platform.kimi.ai/docs/pricing/chat (2026-10-03).
 * k3-256k has the same K3 identity within 256K; membership quota multipliers are not prices.
 * K2.8 Preview has no verified platform rate. Extra Usage is RMB and only described as
 * close to platform prices. Neither may silently inherit a USD metered rate.
 * K3 cache writes require TTL evidence absent from these usage counters; lookup rejects them.
 */
export const KIMI_CODING_REFERENCES: ModelTable = {
  k3: rates(3, 15, { read: 0.3 }),
  "k3-256k": rates(3, 15, { read: 0.3 }),
  "kimi-for-coding-highspeed": rates(1.9, 8, { read: 0.38 }),
}
