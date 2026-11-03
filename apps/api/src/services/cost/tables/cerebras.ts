import { type ModelTable, rates } from "../rates"

/**
 * Cerebras's published per-Mtok prices.
 *
 * Provenance: cerebras.ai/pricing (the Developer Tier price table) and
 * inference-docs.cerebras.ai/models/overview, read 2026-11-03. Blast radius: the metered total for
 * `cerebras` accounts.
 *
 * Two public models on the price table, and per-token prices that do **not** vary by tier — the
 * tiers differ on rate limits only, which is why the "Developer Tier" heading on the price table
 * changes nothing here.
 *
 * No cached-input discount is published, so cached tokens bill at the ordinary input rate: that is
 * what a vendor stating no discount costs, and assuming one would under-report every cached
 * request. The flat-rate Cerebras Code plans are a subscription rather than a per-token price —
 * an account on one is marked `subscription` and reports these numbers as an attribution.
 */
export const CEREBRAS_MODELS: ModelTable = {
  "gpt-oss-120b": rates(0.35, 0.75),
  "qwen-3.8-27b": rates(0.99, 1.49),
}
