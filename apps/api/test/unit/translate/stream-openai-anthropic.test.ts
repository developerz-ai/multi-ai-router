/**
 * `chat.completion.chunk` → Anthropic SSE, driven by recorded event sequences.
 *
 * The Anthropic order is the verified one and this direction must emit exactly it
 * (docs/idea/06-protocol-translation.md#streaming-sse-event-mapping), reconstructing the block
 * boundaries openai-chat does not have.
 */

import { describe, expect, test } from "bun:test"
import type { SseEvent, SseFrame } from "../../../src/services/translate"
import { openAiChatToAnthropicStream } from "../../../src/services/translate"
import {
  eventNames,
  openAiChatChunk,
  openAiChatFrame,
  openAiChatUsageWire,
  payloads,
} from "./fixtures"

const DONE: SseFrame = { event: null, data: "[DONE]" }

interface AnthropicEvent {
  type: string
  index?: number
  message?: Record<string, unknown>
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: Record<string, unknown>
}

function translator(): ReturnType<typeof openAiChatToAnthropicStream> {
  return openAiChatToAnthropicStream({ id: "fallback", model: "requested-model" })
}

function run(frames: readonly SseFrame[]): { events: SseEvent[]; unrecognized: string | null } {
  const stream = translator()
  const events: SseEvent[] = []
  for (const frame of frames) events.push(...stream.push(frame))
  events.push(...stream.flush())
  return { events, unrecognized: stream.unrecognizedStopReason() }
}

const finish = (reason: string): SseFrame =>
  openAiChatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: reason }] })

const usageChunk: SseFrame = openAiChatFrame({
  id: "chatcmpl-1",
  model: "gpt-4o",
  choices: [],
  usage: openAiChatUsageWire(),
})

describe("the emitted order", () => {
  test("a text completion emits exactly the Anthropic sequence", () => {
    const { events } = run([
      openAiChatChunk({ role: "assistant", content: "" }),
      openAiChatChunk({ content: "hello" }),
      openAiChatChunk({ content: " world" }),
      finish("stop"),
      usageChunk,
      DONE,
    ])
    expect(eventNames(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("message_start states the upstream's own id and model, with an empty content array", () => {
    const events = translator().push(openAiChatChunk({ role: "assistant", content: "" }))
    expect(payloads(events)[0]).toEqual({
      type: "message_start",
      message: {
        id: "chatcmpl-1",
        type: "message",
        role: "assistant",
        model: "gpt-4o",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  })

  test("the caller's fallbacks stand in until a chunk names its own", () => {
    const events = translator().push(
      openAiChatFrame({ choices: [{ index: 0, delta: { content: "x" } }] }),
    )
    const start = payloads(events)[0] as AnthropicEvent
    expect(start.message).toMatchObject({ id: "fallback", model: "requested-model" })
  })

  test("a text block is opened once and its deltas share the index", () => {
    const { events } = run([openAiChatChunk({ content: "a" }), openAiChatChunk({ content: "b" })])
    const payload = payloads(events) as AnthropicEvent[]
    expect(payload[1]).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
    expect(payload[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "a" },
    })
    expect(payload[3]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "b" },
    })
  })

  test("an empty content delta opens no block — absence is not content", () => {
    const events = translator().push(openAiChatChunk({ role: "assistant", content: "" }))
    expect(eventNames(events)).toEqual(["message_start"])
  })

  test("each emitted event repeats its type inside the payload, as Anthropic does", () => {
    const { events } = run([openAiChatChunk({ content: "a" }), finish("stop"), DONE])
    for (const event of events) {
      expect((JSON.parse(event.data) as AnthropicEvent).type).toBe(event.event)
    }
  })
})

describe("the terminal events", () => {
  test("stop_reason and usage land on message_delta, and message_stop carries nothing", () => {
    const { events } = run([openAiChatChunk({ content: "hi" }), finish("stop"), usageChunk, DONE])
    const payload = payloads(events) as AnthropicEvent[]
    expect(payload.at(-2)).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      // prompt_tokens is the whole prompt; the uncached remainder is what Anthropic calls input.
      usage: { output_tokens: 50, input_tokens: 110, cache_read_input_tokens: 20 },
    })
    expect(payload.at(-1)).toEqual({ type: "message_stop" })
  })

  test("usage is stated only where the upstream counted", () => {
    const { events } = run([openAiChatChunk({ content: "hi" }), finish("stop"), DONE])
    const delta = (payloads(events) as AnthropicEvent[]).at(-2)
    expect(delta?.usage).toEqual({ output_tokens: 0 })
  })

  test("a tool_calls finish becomes tool_use, and the superseded function_call form too", () => {
    for (const [reason, expected] of [
      ["tool_calls", "tool_use"],
      ["length", "max_tokens"],
      ["content_filter", "end_turn"],
      ["function_call", "tool_use"],
    ] as const) {
      const { events } = run([openAiChatChunk({ content: "x" }), finish(reason), DONE])
      const delta = (payloads(events) as AnthropicEvent[]).at(-2)
      expect(delta?.delta).toEqual({ stop_reason: expected, stop_sequence: null })
    }
  })

  test("an unrecognized finish reason maps conservatively and is reported for the caller to log", () => {
    const { events, unrecognized } = run([
      openAiChatChunk({ content: "x" }),
      finish("banana"),
      DONE,
    ])
    const delta = (payloads(events) as AnthropicEvent[]).at(-2)
    expect(delta?.delta).toMatchObject({ stop_reason: "end_turn" })
    expect(unrecognized).toBe("banana")
  })

  test("the open block is closed on the finish chunk, before the usage chunk arrives", () => {
    const stream = translator()
    stream.push(openAiChatChunk({ content: "hi" }))
    expect(eventNames(stream.push(finish("stop")))).toEqual(["content_block_stop"])
    expect(stream.push(usageChunk)).toEqual([])
  })

  test("flush terminates a stream whose upstream closed without a [DONE]", () => {
    const stream = translator()
    stream.push(openAiChatChunk({ content: "hi" }))
    stream.push(finish("stop"))
    expect(eventNames(stream.flush())).toEqual(["message_delta", "message_stop"])
    expect(stream.flush()).toEqual([])
  })

  test("a truncated stream is not given a synthesized finish", () => {
    const stream = translator()
    stream.push(openAiChatChunk({ content: "partial" }))
    expect(stream.flush()).toEqual([])
  })

  test("nothing is emitted after termination", () => {
    const stream = translator()
    stream.push(DONE)
    expect(stream.push(openAiChatChunk({ content: "late" }))).toEqual([])
  })

  test("an empty completion still emits a well-formed sequence", () => {
    const { events } = run([DONE])
    expect(eventNames(events)).toEqual(["message_start", "message_delta", "message_stop"])
    const delta = (payloads(events) as AnthropicEvent[])[1]
    // No finish reason ever arrived, so none is claimed.
    expect(delta?.delta).toEqual({ stop_reason: null, stop_sequence: null })
  })
})

describe("tool calls", () => {
  const opening = openAiChatChunk({
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
    ],
  })

  test("the first tool_calls delta opens a tool_use block with the id and name", () => {
    const events = translator().push(opening)
    expect(payloads(events)[1]).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    })
  })

  test("argument deltas become input_json_delta on the block that call opened", () => {
    const stream = translator()
    stream.push(opening)
    const events = stream.push(
      openAiChatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }),
    )
    expect(payloads(events)).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city"' },
      },
    ])
  })

  test("a text block is closed before a tool block opens", () => {
    const stream = translator()
    stream.push(openAiChatChunk({ content: "thinking about it" }))
    expect(eventNames(stream.push(opening))).toEqual(["content_block_stop", "content_block_start"])
  })

  const second = openAiChatChunk({
    tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "lookup" } }],
  })

  test("a second call waits rather than closing the block the first is still streaming into", () => {
    const stream = translator()
    stream.push(opening)
    expect(stream.push(second)).toEqual([])
  })

  test("parallel calls get their own contiguous block indices", () => {
    const { events } = run([opening, second, finish("tool_calls"), DONE])
    const starts = (payloads(events) as AnthropicEvent[]).filter(
      (event) => event.type === "content_block_start",
    )
    expect(starts).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_2", name: "lookup", input: {} },
      },
    ])
  })

  test("the whole tool sequence closes and terminates in order", () => {
    const { events } = run([
      opening,
      openAiChatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"NY"}' } }] }),
      finish("tool_calls"),
      DONE,
    ])
    expect(eventNames(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })
})

/**
 * The shapes a compatible upstream is entitled to send and OpenAI's own never does.
 *
 * `index` may be revisited after a later call has been announced (vLLM, SGLang, Fireworks,
 * Together) or omitted altogether (LM Studio, Ollama), and a reader that keeps only the block it
 * opened last answers either with a `tool_use` whose `input` is truncated — under a `stop_reason`
 * saying the call was complete, which no client can tell from the real thing.
 */
describe("tool calls the upstream keys loosely", () => {
  const call = (index: number | null, id: string | null, name: string | null, args: string) =>
    openAiChatChunk({
      tool_calls: [
        {
          ...(index === null ? {} : { index }),
          ...(id === null ? {} : { id }),
          function: { ...(name === null ? {} : { name }), arguments: args },
        },
      ],
    })

  /** Every `input_json_delta` for a block, concatenated — the `input` the client ends up parsing. */
  function toolInput(events: readonly SseEvent[]): Record<number, string> {
    const input: Record<number, string> = {}
    for (const event of payloads(events) as AnthropicEvent[]) {
      if (event.type !== "content_block_delta" || event.delta?.type !== "input_json_delta") continue
      const index = event.index ?? 0
      input[index] = `${input[index] ?? ""}${String(event.delta.partial_json)}`
    }
    return input
  }

  function toolNames(events: readonly SseEvent[]): unknown[] {
    return (payloads(events) as AnthropicEvent[])
      .filter((event) => event.content_block?.type === "tool_use")
      .map((event) => event.content_block?.name)
  }

  test("arguments revisiting an earlier index after a later call opened still arrive", () => {
    const { events } = run([
      call(0, "call_1", "get_weather", ""),
      call(1, "call_2", "lookup", ""),
      call(0, null, null, '{"city":"NY"}'),
      call(1, null, null, '{"q":"x"}'),
      finish("tool_calls"),
      DONE,
    ])
    expect(toolInput(events)).toEqual({ 0: '{"city":"NY"}', 1: '{"q":"x"}' })
  })

  test("one chunk announcing both calls does not cost the first one its arguments", () => {
    const { events } = run([
      openAiChatChunk({
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } },
          { index: 1, id: "call_2", function: { name: "lookup", arguments: "" } },
        ],
      }),
      call(0, null, null, '{"city":"NY"}'),
      call(1, null, null, '{"q":"x"}'),
      finish("tool_calls"),
      DONE,
    ])
    expect(toolNames(events)).toEqual(["get_weather", "lookup"])
    expect(toolInput(events)).toEqual({ 0: '{"city":"NY"}', 1: '{"q":"x"}' })
  })

  test("held calls are still emitted as one open block at a time, never overlapping", () => {
    const { events } = run([
      call(0, "call_1", "get_weather", ""),
      call(1, "call_2", "lookup", ""),
      call(0, null, null, "{}"),
      call(1, null, null, "{}"),
      finish("tool_calls"),
      DONE,
    ])
    expect(eventNames(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("calls that state no index at all stay distinct rather than collapsing into one", () => {
    const { events } = run([
      call(null, "call_1", "get_weather", '{"city":"NY"}'),
      call(null, "call_2", "lookup", '{"q":"x"}'),
      finish("tool_calls"),
      DONE,
    ])
    expect(toolNames(events)).toEqual(["get_weather", "lookup"])
    expect(toolInput(events)).toEqual({ 0: '{"city":"NY"}', 1: '{"q":"x"}' })
  })

  test("an unkeyed delta naming neither an id nor a function continues the call before it", () => {
    const { events } = run([
      call(null, "call_1", "get_weather", '{"city"'),
      call(null, null, null, ':"NY"}'),
      finish("tool_calls"),
      DONE,
    ])
    expect(toolNames(events)).toEqual(["get_weather"])
    expect(toolInput(events)).toEqual({ 0: '{"city":"NY"}' })
  })

  test("a truncated stream is given no held call: nothing claims a completion that never came", () => {
    const stream = translator()
    const events: SseEvent[] = []
    for (const frame of [call(0, "call_1", "get_weather", "{}"), call(1, "call_2", "lookup", "{}")])
      events.push(...stream.push(frame))
    events.push(...stream.flush())
    expect(toolNames(events)).toEqual(["get_weather"])
    expect(eventNames(events)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
    ])
  })
})

describe("failure mid-stream", () => {
  test("an error payload becomes an Anthropic error event and ends the stream", () => {
    const stream = translator()
    stream.push(openAiChatChunk({ content: "hi" }))
    const events = stream.push(
      openAiChatFrame({ error: { message: "boom", type: "server_error" } }),
    )
    expect(events).toHaveLength(1)
    expect(payloads(events)[0]).toEqual({
      type: "error",
      error: { type: "api_error", message: "boom" },
    })
    expect(stream.push(DONE)).toEqual([])
    expect(stream.flush()).toEqual([])
  })

  test("a malformed frame is skipped rather than thrown over", () => {
    const stream = translator()
    expect(stream.push({ event: null, data: "{not json" })).toEqual([])
    expect(stream.push({ event: null, data: '"a bare string"' })).toEqual([])
  })

  test("choices beyond the first are dropped, never interleaved", () => {
    const events = translator().push(
      openAiChatFrame({
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [
          { index: 0, delta: { content: "first" }, finish_reason: null },
          { index: 1, delta: { content: "second" }, finish_reason: null },
        ],
      }),
    )
    const deltas = (payloads(events) as AnthropicEvent[]).filter(
      (event) => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.delta).toEqual({ type: "text_delta", text: "first" })
  })
})
