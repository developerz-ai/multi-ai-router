import { type ModelTable, rates } from "../rates"

/**
 * Groq's published per-Mtok prices.
 *
 * Provenance: groq.com/pricing and console.groq.com/docs/models, verified on the date
 * `PRICE_TABLE_AS_OF` names. Blast radius: the metered total for `groq` accounts.
 *
 * Cached input is priced by a stated global rule — half the input rate — and Groq supports caching
 * on the `gpt-oss` models only. Those three carry the halved read rate; everything else takes the
 * default, which bills a cached token at the ordinary input rate, because that is what a vendor
 * publishing no discount costs.
 *
 * `groq/compound` and `groq/compound-mini` are absent by nature rather than by omission: they have
 * no flat rate at all, billing through to whichever underlying model they invoked plus tool fees —
 * the same reason `openrouter` has no shipped table.
 *
 * The two Llama rows are dated for shutdown but still billing, so they stay while they charge.
 */
export const GROQ_MODELS: ModelTable = {
  "openai/gpt-oss-120b": rates(0.15, 0.6, { read: 0.075 }),
  "openai/gpt-oss-20b": rates(0.075, 0.3, { read: 0.0375 }),
  "openai/gpt-oss-safeguard-20b": rates(0.075, 0.3, { read: 0.0375 }),
  "qwen/qwen3.6-27b": rates(0.6, 3),
  "llama-3.3-70b-versatile": rates(0.59, 0.79),
  "llama-3.1-8b-instant": rates(0.05, 0.08),
  "meta-llama/llama-prompt-guard-2-22m": rates(0.03, 0.03),
  "meta-llama/llama-prompt-guard-2-86m": rates(0.04, 0.04),
}
