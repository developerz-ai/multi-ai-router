import { type ModelTable, rates } from "../rates"

/**
 * Groq's published per-Mtok prices.
 *
 * Provenance: console.groq.com/docs/models (the Production and Preview model tables) and
 * console.groq.com/docs/prompt-caching, read 2026-11-03. Blast radius: the metered total for
 * `groq` accounts.
 *
 * Cached input is priced by a stated global rule — half the input rate ("there is a 50% discount
 * for cached input tokens", prompt caching) — and the price table publishes no separate cached
 * column, so the halved read rate is derived here rather than restated per row.
 *
 * `groq/compound` and `groq/compound-mini` are absent by nature rather than by omission: they have
 * no flat rate at all, billing through to whichever underlying model they invoked plus tool fees —
 * the same reason `openrouter` has no shipped table.
 *
 * **The two Llama models are absent**: Groq's table lists `llama-3.3-70b-versatile` and
 * `llama-3.1-8b-instant` as Enterprise models whose price is "Contact Sales" — there is no
 * published per-token rate to state, and a number for a negotiated contract is a fiction rather
 * than a stale fact.
 */
export const GROQ_MODELS: ModelTable = {
  "openai/gpt-oss-120b": rates(0.15, 0.6, { read: 0.075 }),
  "openai/gpt-oss-20b": rates(0.075, 0.3, { read: 0.0375 }),
  "openai/gpt-oss-safeguard-20b": rates(0.075, 0.3, { read: 0.0375 }),
  "qwen/qwen3.8-27b": rates(0.8, 4, { read: 0.4 }),
  "meta-llama/llama-prompt-guard-2-22m": rates(0.03, 0.03),
  "meta-llama/llama-prompt-guard-2-86m": rates(0.04, 0.04),
}
