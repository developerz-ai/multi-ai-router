import { z } from "zod"
import type { UpstreamModelEntry } from "./listing"

/**
 * The stock model-listing parse (`{data: [{id, …}]}`), apart from the asking in `listing.ts`: what
 * each vendor calls a model's size, and how a listing is deduplicated.
 */

/**
 * A positive integer, or null. Everything else — a string, a float, zero, a negative — is read as
 * "this provider did not state a size", because a context window of zero is not a window and a
 * silently coerced `"128000"` would be indistinguishable from a number the provider actually sent.
 */
const size = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null,
  )

/**
 * The union of every spelling a provider listing uses for these two numbers, all optional.
 *
 * Provenance, one field at a time, so a reader can tell which vendor each exists for:
 * `context_length` is OpenRouter's and Together's, `context_window` is Groq's, `max_context_length`
 * is Mistral's, `max_model_len` is vLLM's `ModelCard`, `max_input_tokens`/`max_tokens` are
 * Anthropic's `ModelInfo` pair, and `inputTokenLimit`/`outputTokenLimit` are Google's native
 * camelCase pair (its OpenAI-compatible `/models`, which the `gemini` driver reads, states neither).
 * `top_provider` is OpenRouter's per-endpoint block, which is the more specific of its two answers.
 *
 * A loose object throughout: a provider adding a field must never fail the listing, and an entry
 * that is malformed in a way this cannot read still yields its id.
 */
const entrySchema = z.looseObject({
  id: z.unknown().optional(),
  context_length: size.optional(),
  context_window: size.optional(),
  max_context_length: size.optional(),
  max_model_len: size.optional(),
  max_input_tokens: size.optional(),
  inputTokenLimit: size.optional(),
  max_completion_tokens: size.optional(),
  max_output_tokens: size.optional(),
  outputTokenLimit: size.optional(),
  max_tokens: size.optional(),
  top_provider: z
    .looseObject({
      context_length: size.optional(),
      max_completion_tokens: size.optional(),
    })
    .nullish(),
})

export const listingSchema = z.object({
  data: z.array(entrySchema),
  /** Anthropic only. True means the page cap below cut the answer short. */
  has_more: z.boolean().optional(),
})

type ParsedEntry = z.infer<typeof entrySchema>

export function toEntry(entry: ParsedEntry): UpstreamModelEntry {
  return {
    id: typeof entry.id === "string" ? entry.id.trim() : "",
    // Most specific first. OpenRouter states both a model-wide `context_length` and a per-endpoint
    // `top_provider.context_length`, and the endpoint block is the one describing what an account
    // pointed at it would actually get.
    contextTokens:
      entry.top_provider?.context_length ??
      entry.context_length ??
      entry.context_window ??
      entry.max_context_length ??
      entry.max_model_len ??
      entry.max_input_tokens ??
      entry.inputTokenLimit ??
      null,
    maxOutputTokens:
      entry.top_provider?.max_completion_tokens ??
      entry.max_completion_tokens ??
      entry.max_output_tokens ??
      entry.outputTokenLimit ??
      // Last: Anthropic's spelling of the output ceiling, and the most generic-sounding name here.
      entry.max_tokens ??
      null,
  }
}

/**
 * Deduplicated by id and sorted. An entry with no usable id is dropped rather than failing the
 * whole listing over one malformed row; the first entry for an id wins, because a provider that
 * lists a model twice has already said what it means the first time.
 */
export function dedupe(entries: readonly UpstreamModelEntry[]): readonly UpstreamModelEntry[] {
  const byId = new Map<string, UpstreamModelEntry>()
  for (const entry of entries) {
    if (entry.id.length === 0 || byId.has(entry.id)) continue
    byId.set(entry.id, entry)
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}
