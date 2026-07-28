import type { ContextTable } from "@multi-ai-router/core"

/**
 * z.ai (GLM) context windows.
 *
 * Provenance: z.ai's published model reference, cross-checked against a live aggregator listing on
 * the date `CONTEXT_TABLE_AS_OF` names. Shipped because z.ai's own listing — verified against
 * `https://api.z.ai/api/paas/v4/models` while writing this — returns nothing but
 * `{id, object, created, owned_by}` per entry.
 *
 * Every id z.ai listed on that date has a row here. Blast radius of a stale one: a display number
 * labelled `shipped`; routing never reads it.
 */
export const ZAI_WINDOWS: ContextTable = {
  "glm-5.2": { contextTokens: 1_048_576, maxOutputTokens: 131_072 },
  "glm-5.1": { contextTokens: 204_800, maxOutputTokens: 128_000 },
  "glm-5": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  /** The turbo tier trades a little context for speed — 202752, not 204800. */
  "glm-5-turbo": { contextTokens: 202_752, maxOutputTokens: 131_072 },
  "glm-5v-turbo": { contextTokens: 202_752, maxOutputTokens: 131_072 },
  "glm-4.7": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "glm-4.7-flash": { contextTokens: 202_752, maxOutputTokens: 16_384 },
  "glm-4.6": { contextTokens: 204_800, maxOutputTokens: 131_072 },
  "glm-4.6v": { contextTokens: 131_072, maxOutputTokens: 32_768 },
  "glm-4.5": { contextTokens: 131_072, maxOutputTokens: 98_304 },
  "glm-4.5-air": { contextTokens: 131_072, maxOutputTokens: 98_304 },
  "glm-4.5v": { contextTokens: 65_536, maxOutputTokens: 16_384 },
}
