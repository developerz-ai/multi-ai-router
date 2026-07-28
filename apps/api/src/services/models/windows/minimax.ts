import type { ContextTable } from "@multi-ai-router/core"

/**
 * MiniMax context windows.
 *
 * Provenance: MiniMax's published model reference, cross-checked against a live aggregator listing
 * on the date `CONTEXT_TABLE_AS_OF` names. Shipped because MiniMax's own listing — verified against
 * `https://api.minimax.io/v1/models` while writing this — returns `{id, object, created, owned_by}`
 * and no size.
 *
 * **The `-highspeed` rows are stated, not derived.** That listing offers both `MiniMax-M2.5` and
 * `MiniMax-M2.5-highspeed`, and a suffix-stripping rule would have been a guess that the two are
 * the same model at a different serving tier. They are — MiniMax documents them as one model with
 * two throughput tiers — but the row says so explicitly rather than a normalizer inferring it,
 * because the day a suffix means something else, an inference is silently wrong and a row is not.
 */
export const MINIMAX_WINDOWS: ContextTable = {
  "minimax-m3": { contextTokens: 1_048_576, maxOutputTokens: 512_000 },
  "minimax-m2.7": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "minimax-m2.7-highspeed": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "minimax-m2.5": { contextTokens: 204_800, maxOutputTokens: 196_608 },
  "minimax-m2.5-highspeed": { contextTokens: 204_800, maxOutputTokens: 196_608 },
  "minimax-m2.1": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "minimax-m2.1-highspeed": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "minimax-m2": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "minimax-m1": { contextTokens: 1_000_000, maxOutputTokens: 40_000 },
  "minimax-01": { contextTokens: 1_000_192 },
}
