import { type ModelTable, rates } from "../rates"

/**
 * Together's published per-Mtok serverless prices.
 *
 * Provenance: docs.together.ai/docs/serverless/models, read 2026-11-03. Blast radius: the metered
 * total for `together` accounts.
 *
 * Priced per model, not by a parameter bucket — the old Lite/Turbo/Reference tiers are gone, and
 * "Turbo" now survives only inside a model's name. Dedicated GPU-hour and provisioned-throughput
 * contracts are priced separately and are not per-token at all, so an account on one needs an
 * override rather than a row here.
 *
 * `Qwen/Qwen3.7-Max` is absent: the vendor's two pages still disagree on its price — the serverless
 * docs table quotes $2.50 / $0.50 / $7.50 while the marketing pricing page quotes $1.50 / $0.30 /
 * $4.50 — and shipping either would be picking a side rather than stating a price.
 *
 * Keys are lowercase because every lookup is (`modelLookupKeys`); Together's own ids are mixed
 * case, and the client's spelling is normalized before it reaches a table.
 */
export const TOGETHER_MODELS: ModelTable = {
  "deepseek-ai/deepseek-v4-pro-0813": rates(1.32, 3.96, { read: 0.13 }),
  "deepseek-ai/deepseek-v4.1-flash": rates(0.3, 1.2, { read: 0.006 }),
  "deepseek-ai/deepseek-v4.1-flash-1017": rates(0.3, 1.2, { read: 0.006 }),
  "meta-models/muse-glimmer-30b": rates(0.35, 1.5, { read: 0.04 }),
  "meta-models/muse-spark-open-816b-a42b": rates(1.25, 4.25, { read: 0.15 }),
  "minimaxai/minimax-m3.1-flash": rates(0.15, 0.6, { read: 0.015 }),
  "moonshotai/kimi-k3": rates(3, 15, { read: 0.3 }),
  "nvidia/nvidia-nemotron-3.5-super-vl": rates(0.15, 0.5, { read: 0.02 }),
  "openai/gpt-oss-120b": rates(0.15, 0.6),
  "qwen/qwen3.5-9b": rates(0.17, 0.25),
  "qwen/qwen3.6-plus": rates(0.5, 3),
  "qwen/qwen3.7-plus": rates(0.32, 1.28),
  "qwen/qwen3.8-flash": rates(0.15, 0.47),
  "reflection/beam-1.0-501b-a23b": rates(0.4, 1.2, { read: 0.04 }),
  "zai-org/glm-5.2": rates(1.4, 4.4, { read: 0.26 }),
  "zai-org/glm-5.3": rates(1.4, 4.4, { read: 0.26 }),
  "zai-org/glm-5.3-flash": rates(0.15, 0.5, { read: 0.03 }),
}
