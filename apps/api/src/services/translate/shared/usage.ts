import { z } from "zod"

/**
 * Token counts across the anthropic ⇄ openai-chat seam.
 *
 * The two dialects disagree about what "prompt" means, and the disagreement is the whole module:
 *
 * - Anthropic's `input_tokens` is the **uncached remainder**. Total prompt size is
 *   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
 * - OpenAI's `prompt_tokens` is the **whole prompt**, with `prompt_tokens_details.cached_tokens` a
 *   subset of it.
 *
 * So the crossing is not a rename. Toward openai-chat the three input fields are summed, or a
 * cache-heavy request reports a handful of tokens and every client-side cost estimate built on it
 * is wrong by the cache-hit ratio — the better the caching, the worse the error
 * (`docs/idea/06-protocol-translation.md#usage-and-token-fields`). Toward anthropic the cached
 * count is subtracted back out, for the same reason in reverse. `services/usage/tokens.ts` reads
 * the same rule off the wire for the `UsageRecord`, which stores the **upstream's own** numbers and
 * is unaffected by anything here.
 *
 * **A missing field is null, never zero.** Zero is a measurement — "the upstream counted, and the
 * answer was none" — and reporting it for a field the upstream never sent invents data. Every
 * count is therefore `number | null` end to end.
 *
 * Nothing here throws. Usage arrives on a response, and by then bytes are on the wire: a malformed
 * usage block is worth reporting as absent, never worth failing a request that already succeeded
 * (`06-protocol-translation.md#streaming-sse-event-mapping`, "Rejected: nothing at stream time").
 */

/** One bad field yields null rather than discarding the whole block — hence per-field `.catch`. */
const tokenCount = z.number().int().nonnegative().nullish().catch(null)

export const anthropicUsageSchema = z.looseObject({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
})

export const openAiChatUsageSchema = z.looseObject({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  total_tokens: tokenCount,
  prompt_tokens_details: z.looseObject({ cached_tokens: tokenCount }).nullish().catch(null),
  completion_tokens_details: z.looseObject({ reasoning_tokens: tokenCount }).nullish().catch(null),
})

export interface AnthropicUsage {
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly cache_creation_input_tokens: number | null
  readonly cache_read_input_tokens: number | null
}

export interface OpenAiChatUsage {
  readonly prompt_tokens: number | null
  readonly completion_tokens: number | null
  readonly total_tokens: number | null
  readonly prompt_tokens_details?: { readonly cached_tokens: number | null } | undefined
}

/** @returns null when the value is not a usage object at all — an absent or malformed block. */
export function parseAnthropicUsage(value: unknown): AnthropicUsage | null {
  const parsed = anthropicUsageSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    input_tokens: parsed.data.input_tokens ?? null,
    output_tokens: parsed.data.output_tokens ?? null,
    cache_creation_input_tokens: parsed.data.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: parsed.data.cache_read_input_tokens ?? null,
  }
}

/** @returns null when the value is not a usage object at all — an absent or malformed block. */
export function parseOpenAiChatUsage(value: unknown): OpenAiChatUsage | null {
  const parsed = openAiChatUsageSchema.safeParse(value)
  if (!parsed.success) return null

  const cached = parsed.data.prompt_tokens_details?.cached_tokens ?? null
  return {
    prompt_tokens: parsed.data.prompt_tokens ?? null,
    completion_tokens: parsed.data.completion_tokens ?? null,
    total_tokens: parsed.data.total_tokens ?? null,
    prompt_tokens_details: cached === null ? undefined : { cached_tokens: cached },
  }
}

/**
 * Anthropic usage → openai-chat usage.
 *
 * `cache_creation_input_tokens` has no field of its own on this side and is **folded into**
 * `prompt_tokens` rather than dropped: those tokens were read by the model and billed, so leaving
 * them out of the prompt total would under-report the request.
 *
 * `completion_tokens_details.reasoning_tokens` is never synthesized — Anthropic reports no
 * counterpart, and an absent detail is honest where a zero would not be.
 */
export function usageToOpenAiChat(usage: AnthropicUsage): OpenAiChatUsage {
  const cached = usage.cache_read_input_tokens
  const prompt = sum([usage.input_tokens, usage.cache_creation_input_tokens, cached])
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output_tokens,
    total_tokens: sum([prompt, usage.output_tokens]),
    prompt_tokens_details: cached === null ? undefined : { cached_tokens: cached },
  }
}

/**
 * openai-chat usage → Anthropic usage.
 *
 * `cache_creation_input_tokens` is always null: openai-chat reports cache *reads* and never
 * distinguishes the write that populated the cache, and a router that guessed at it would be
 * inventing the one number an operator reads to decide whether caching is paying for itself.
 *
 * `total_tokens` and `completion_tokens_details.reasoning_tokens` are dropped — Anthropic states
 * neither, and its total is derived from the fields above by every client that wants one.
 */
export function usageToAnthropic(usage: OpenAiChatUsage): AnthropicUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? null
  return {
    input_tokens: difference(usage.prompt_tokens, cached),
    output_tokens: usage.completion_tokens,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: cached,
  }
}

/** Null only when every term is null: one known term still makes a partial total worth reporting. */
function sum(values: readonly (number | null)[]): number | null {
  let total: number | null = null
  for (const value of values) {
    if (value === null) continue
    total = (total ?? 0) + value
  }
  return total
}

/** Clamped at zero: an upstream reporting more cached tokens than prompt tokens is wrong, and a
 * negative count would be a second wrong answer layered on the first. */
function difference(minuend: number | null, subtrahend: number | null): number | null {
  if (minuend === null) return null
  if (subtrahend === null) return minuend
  return Math.max(0, minuend - subtrahend)
}
