import type { ProviderId } from "@multi-ai-router/core"
import type { ModelCatalogEntry } from "@multi-ai-router/db"
import type { UpstreamModelEntry } from "./listing"
import { lookupContextWindow } from "./windows"

/**
 * Turn what an upstream said into what the catalog stores, filling the gap from the shipped table.
 *
 * **A row is sourced whole, never field by field.** If the listing stated a context window, the row
 * is the listing's — output ceiling included, and null if the listing did not mention one. If it
 * did not, the row is the shipped table's entirely. The alternative is a row whose window came from
 * one place and whose ceiling came from another, which makes `contextSource` a question with no
 * answer: the label exists so a reader can judge how current a number is, and a mixed row cannot be
 * judged. Losing a shipped output ceiling to a live listing that omitted one is the cheaper mistake
 * — an unknown ceiling reads as unknown, while a mislabelled one reads as verified.
 *
 * A model in neither is simply unknown: an id and two nulls. It still belongs in the catalog,
 * because the fact that this router can reach it is worth stating on its own.
 */
export function catalogEntry(provider: ProviderId, entry: UpstreamModelEntry): ModelCatalogEntry {
  if (entry.contextTokens !== null) {
    return {
      modelId: entry.id,
      contextTokens: entry.contextTokens,
      maxOutputTokens: entry.maxOutputTokens,
      contextSource: "upstream",
    }
  }

  const shipped = lookupContextWindow(provider, entry.id)
  if (shipped === null) {
    return {
      modelId: entry.id,
      contextTokens: null,
      // An output ceiling with no window beside it is still worth keeping — a provider that states
      // only `max_completion_tokens` has told us something true.
      maxOutputTokens: entry.maxOutputTokens,
      contextSource: entry.maxOutputTokens === null ? null : "upstream",
    }
  }

  return {
    modelId: entry.id,
    contextTokens: shipped.contextTokens,
    maxOutputTokens: shipped.maxOutputTokens ?? null,
    contextSource: "shipped",
  }
}
