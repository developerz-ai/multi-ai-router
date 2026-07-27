import { type ModelTable, rates } from "../rates"

/**
 * Together's published per-Mtok serverless prices.
 *
 * Provenance: docs.together.ai/docs/serverless/models, keyed by the API model string a client
 * sends; verified on the date `PRICE_TABLE_AS_OF` names. Blast radius: the metered total for
 * `together` accounts.
 *
 * Priced per model, not by a parameter bucket — the old Lite/Turbo/Reference tiers are gone, and
 * "Turbo" now survives only inside a model's name. Dedicated GPU-hour and provisioned-throughput
 * contracts are priced separately and are not per-token at all, so an account on one needs an
 * override rather than a row here.
 *
 * `Qwen/Qwen3.7-Max` is absent: the vendor's own two pages disagree on its cached-input rate, and
 * shipping either would be picking a side rather than stating a price.
 *
 * Keys are lowercase because every lookup is (`modelLookupKeys`); Together's own ids are mixed
 * case, and the client's spelling is normalized before it reaches a table.
 */
export const TOGETHER_MODELS: ModelTable = {
  "deepseek-ai/deepseek-v4-pro": rates(1.74, 3.48, { read: 0.2 }),
  "moonshotai/kimi-k3": rates(3, 15, { read: 0.3 }),
  "moonshotai/kimi-k2.7-code": rates(0.95, 4, { read: 0.19 }),
  "moonshotai/kimi-k2.6": rates(1.2, 4.5, { read: 0.2 }),
  "zai-org/glm-5.2": rates(1.4, 4.4, { read: 0.26 }),
  "minimaxai/minimax-m3": rates(0.3, 1.2, { read: 0.06 }),
  "qwen/qwen3.7-plus": rates(0.32, 1.28),
  "qwen/qwen3.5-9b": rates(0.17, 0.25),
  "openai/gpt-oss-120b": rates(0.15, 0.6),
  "openai/gpt-oss-20b": rates(0.05, 0.2),
  "meta-llama/llama-3.3-70b-instruct-turbo": rates(1.04, 1.04),
  "google/gemma-4-31b-it": rates(0.39, 0.97),
}
