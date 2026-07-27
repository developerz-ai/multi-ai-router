import { type ModelTable, rates } from "../rates"

/**
 * Cerebras's published per-Mtok prices.
 *
 * Provenance: cerebras.ai/pricing and inference-docs.cerebras.ai/models/overview, verified on the
 * date `PRICE_TABLE_AS_OF` names. Blast radius: the metered total for `cerebras` accounts.
 *
 * Three public models, and per-token prices that do **not** vary by tier — the tiers differ on rate
 * limits only, which is why the "Developer Tier" heading on the price table changes nothing here.
 *
 * No cached-input discount is published, so cached tokens bill at the ordinary input rate: that is
 * what a vendor stating no discount costs, and assuming one would under-report every cached
 * request. The flat-rate Cerebras Code plans are a subscription rather than a per-token price —
 * an account on one is marked `subscription` and reports these numbers as an attribution.
 */
export const CEREBRAS_MODELS: ModelTable = {
  "gpt-oss-120b": rates(0.35, 0.75),
  "zai-glm-4.7": rates(2.25, 2.75),
  "gemma-4-31b": rates(0.99, 1.49),
}
