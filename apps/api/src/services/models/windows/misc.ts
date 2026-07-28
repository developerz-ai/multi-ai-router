import type { ContextTable } from "@multi-ai-router/core"

/**
 * The remaining bare listings: DeepSeek and xAI.
 *
 * One file rather than two of four rows each. Both vendors ship a short, slow-moving catalog and
 * both answer their `/models` endpoint with an id and nothing else, which is the only property that
 * puts a vendor in a shipped table at all. Google and Mistral are deliberately **absent**: their
 * listings state `inputTokenLimit`/`outputTokenLimit` and `max_context_length` respectively, so the
 * parser reads a live number for them and a shipped row would only be a staler copy of it.
 *
 * Provenance: each vendor's published model reference, cross-checked against a live aggregator
 * listing on the date `CONTEXT_TABLE_AS_OF` names.
 */
export const DEEPSEEK_WINDOWS: ContextTable = {
  "deepseek-v4-pro": { contextTokens: 1_048_576, maxOutputTokens: 384_000 },
  "deepseek-v4-flash": { contextTokens: 1_048_576, maxOutputTokens: 393_216 },
  "deepseek-v3.2": { contextTokens: 163_840, maxOutputTokens: 65_536 },
  "deepseek-chat": { contextTokens: 163_840, maxOutputTokens: 65_536 },
  "deepseek-reasoner": { contextTokens: 163_840, maxOutputTokens: 65_536 },
}

/**
 * xAI publishes a context length and no output ceiling, so `maxOutputTokens` is absent rather than
 * invented — the shape `ContextWindow` makes optional for exactly this case.
 */
export const XAI_WINDOWS: ContextTable = {
  "grok-4.20": { contextTokens: 2_000_000 },
  "grok-4.3": { contextTokens: 1_000_000 },
  "grok-4.5": { contextTokens: 500_000 },
}
