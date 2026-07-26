import type { SseEvent, SseFrame } from "../../../src/services/translate"

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
  parallel_tool_calls?: boolean | null
  reasoning_effort?: string | null
  n?: number | null
  logprobs?: boolean | null
  top_logprobs?: number | null
  response_format?: unknown
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

export interface RawOpenAiResponsesRequest {
  model: string
  input: unknown
  instructions?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  previous_response_id?: string
  store?: boolean
  include?: string[]
  conversation?: unknown
  prompt?: unknown
  background?: boolean
  reasoning?: unknown
  text?: unknown
}

export function openAiResponsesRequest(
  overrides: Partial<RawOpenAiResponsesRequest> = {},
): RawOpenAiResponsesRequest {
  return {
    model: "gpt-5",
    input: [{ role: "user", content: "hello" }],
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

/** An Anthropic frame off the wire: `event:` named, `type` repeated inside the payload. */
export function anthropicFrame(type: string, payload: Record<string, unknown> = {}): SseFrame {
  return { event: type, data: JSON.stringify({ type, ...payload }) }
}

/** An openai-chat frame off the wire: data only, no `event:` line. */
export function openAiChatFrame(payload: Record<string, unknown>): SseFrame {
  return { event: null, data: JSON.stringify(payload) }
}

/**
 * An openai-responses frame off the wire: `event:` named, `type` repeated inside the payload — a
 * Responses stream states its event type in both places, the same redundancy `anthropicFrame` models.
 */
export function responsesFrame(type: string, payload: Record<string, unknown> = {}): SseFrame {
  return { event: type, data: JSON.stringify({ type, ...payload }) }
}

/** An openai-responses `response` object off the wire, non-streaming. */
export function responsesBodyWire(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "resp_01",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "gpt-5",
    output: [],
    incomplete_details: null,
    error: null,
    ...overrides,
  }
}

export function responsesTextItem(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
    ...overrides,
  }
}

export function responsesFunctionCallItem(overrides: Record<string, unknown> = {}) {
  return {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "get_weather",
    arguments: '{"city":"sf"}',
    status: "completed",
    ...overrides,
  }
}

export function openAiChatChunk(
  delta: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): SseFrame {
  return openAiChatFrame({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "gpt-4o",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...overrides,
  })
}

/** Every emitted payload, decoded — the shape an assertion actually wants to read. */
export function payloads(events: readonly SseEvent[]): unknown[] {
  return events.filter((event) => event.data !== "[DONE]").map((event) => JSON.parse(event.data))
}

export function eventNames(events: readonly SseEvent[]): (string | undefined)[] {
  return events.map((event) => event.event)
}
