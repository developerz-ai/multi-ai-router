import { z } from "zod"
import type { AnthropicUsage } from "./usage"

/**
 * The Anthropic stream event schemas both `anthropic → OpenAI` stream translators read. Loose and
 * forgiving by construction (`nullish().catch(null)`), so a field read for one pair never changes
 * what the other accepts; one copy, so a fix to the reading lands in both pairs.
 */
export const messageStartSchema = z.looseObject({
  message: z
    .looseObject({
      id: z.string().nullish().catch(null),
      model: z.string().nullish().catch(null),
      usage: z.unknown().optional(),
    })
    .nullish(),
})

export const blockStartSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  content_block: z.looseObject({
    type: z.string(),
    text: z.string().nullish().catch(null),
    id: z.string().nullish().catch(null),
    name: z.string().nullish().catch(null),
    input: z.unknown().optional(),
  }),
})

export const blockDeltaSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  delta: z.looseObject({
    type: z.string(),
    text: z.string().nullish().catch(null),
    thinking: z.string().nullish().catch(null),
    partial_json: z.string().nullish().catch(null),
  }),
})

export const messageDeltaSchema = z.looseObject({
  delta: z.looseObject({ stop_reason: z.string().nullish().catch(null) }).nullish(),
  usage: z.unknown().optional(),
})

/**
 * The arguments a `tool_use` block that streams no `input_json_delta` closes with.
 *
 * Anthropic itself always starts a call with `input: {}` and streams the arguments as deltas, so
 * `"{}"` is right for it. A compatible upstream may instead state the whole call on
 * `content_block_start`; replacing that with `"{}"` hands the client a call with no arguments. So
 * a non-empty object stated on the start is the call's arguments.
 */
export function startedArguments(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "{}"
  return Object.keys(input).length === 0 ? "{}" : JSON.stringify(input)
}

export function eventType(name: string | null, payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "type" in payload) {
    const type = (payload as { type: unknown }).type
    if (typeof type === "string") return type
  }
  return name
}

/** The final counts win field by field: `message_start` states input, `message_delta` output. */
export function mergeUsage(
  start: AnthropicUsage | null,
  end: AnthropicUsage | null,
): AnthropicUsage | null {
  if (start === null) return end
  if (end === null) return start
  return {
    input_tokens: end.input_tokens ?? start.input_tokens,
    output_tokens: end.output_tokens ?? start.output_tokens,
    cache_creation_input_tokens:
      end.cache_creation_input_tokens ?? start.cache_creation_input_tokens,
    cache_read_input_tokens: end.cache_read_input_tokens ?? start.cache_read_input_tokens,
  }
}

export function readBlockIndex(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null || !("index" in payload)) return undefined
  return typeof payload.index === "number" &&
    Number.isSafeInteger(payload.index) &&
    payload.index >= 0
    ? payload.index
    : undefined
}
