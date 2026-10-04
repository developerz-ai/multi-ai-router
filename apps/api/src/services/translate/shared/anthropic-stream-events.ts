import type { AnthropicUsage } from "./usage"

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
