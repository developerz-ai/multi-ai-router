/**
 * Canned wire bodies for the translate unit tests, one builder per shape.
 *
 * These are plain objects — not the exported `Anthropic*`/`OpenAiChat*` types — because a
 * translator's input is `unknown`: it is JSON off the wire, not a value this codebase already
 * trusts. `Partial<T> = {}` overrides merge shallowly at the top level, matching the pattern in
 * `test/unit/routing/fixtures.ts`.
 */

export interface RawAnthropicRequest {
  model: string
  messages: unknown[]
  max_tokens: number
  system?: unknown
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
}

export function anthropicRequest(
  overrides: Partial<RawAnthropicRequest> = {},
): RawAnthropicRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 1024,
    ...overrides,
  }
}

export interface RawOpenAiChatRequest {
  model: string
  messages: unknown[]
  max_tokens?: number | null
  max_completion_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stop?: string | string[] | null
  stream?: boolean | null
  tools?: unknown[]
  tool_choice?: unknown
  n?: number | null
  logprobs?: boolean | null
  top_logprobs?: number | null
}

export function openAiChatRequest(
  overrides: Partial<RawOpenAiChatRequest> = {},
): RawOpenAiChatRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

export function anthropicTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "get_weather",
    description: "Look up the weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } } },
    ...overrides,
  }
}

export function openAiChatTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "get_weather",
      description: "Look up the weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
    ...overrides,
  }
}

export function anthropicUsageWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 20,
    ...overrides,
  }
}

export function openAiChatUsageWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prompt_tokens: 130,
    completion_tokens: 50,
    total_tokens: 180,
    prompt_tokens_details: { cached_tokens: 20 },
    ...overrides,
  }
}
