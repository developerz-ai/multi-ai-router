/**
 * Anthropic SSE → `chat.completion.chunk`, driven by recorded event sequences
 * (docs/idea/06-protocol-translation.md#streaming-sse-event-mapping).
 */

import { describe, expect, test } from "bun:test"
import type { SseEvent, SseFrame } from "../../../src/services/translate"
import { anthropicToOpenAiChatStream } from "../../../src/services/translate"
import { anthropicFrame, anthropicUsageWire, payloads } from "./fixtures"

const CREATED = 1_700_000_000

interface Chunk {
  id: string
  object: string
  created: number
  model: string
  choices: { index: number; delta: Record<string, unknown>; finish_reason: string | null }[]
  usage?: Record<string, unknown>
}

function translator(): ReturnType<typeof anthropicToOpenAiChatStream> {
  return anthropicToOpenAiChatStream({ created: CREATED, id: "fallback", model: "requested-model" })
}

/** Feeds a whole recorded stream and returns every event, in order. */
function run(frames: readonly SseFrame[]): { events: SseEvent[]; unrecognized: string | null } {
  const stream = translator()
  const events: SseEvent[] = []
  for (const frame of frames) events.push(...stream.push(frame))
  events.push(...stream.flush())
  return { events, unrecognized: stream.unrecognizedStopReason() }
}

const messageStart = anthropicFrame("message_start", {
  message: { id: "msg_01", model: "claude-sonnet-4-5", usage: anthropicUsageWire() },
})

function textBlock(text: string): SseFrame[] {
  return [
    anthropicFrame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text },
    }),
    anthropicFrame("content_block_stop", { index: 0 }),
  ]
}

function messageDelta(stopReason: string | null, outputTokens = 50): SseFrame {
  return anthropicFrame("message_delta", {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
}

describe("the text path", () => {
  test("message_start becomes the first chunk, carrying delta.role", () => {
    const [chunk] = payloads(translator().push(messageStart)) as Chunk[]
    expect(chunk?.choices[0]?.delta).toEqual({ role: "assistant", content: "" })
    expect(chunk?.finish_reason).toBeUndefined()
    expect(chunk?.object).toBe("chat.completion.chunk")
    expect(chunk?.created).toBe(CREATED)
  })

  test("the upstream's own id and model are carried, not minted", () => {
    const [chunk] = payloads(translator().push(messageStart)) as Chunk[]
    expect(chunk?.id).toBe("msg_01")
    expect(chunk?.model).toBe("claude-sonnet-4-5")
  })

  test("the caller's fallbacks stand in until message_start names its own", () => {
    const stream = translator()
    const [chunk] = payloads(
      stream.push(
        anthropicFrame("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        }),
      ),
    ) as Chunk[]
    expect(chunk?.id).toBe("fallback")
    expect(chunk?.model).toBe("requested-model")
  })

  test("content_block_start and content_block_stop for text emit nothing — they are implied", () => {
    const stream = translator()
    stream.push(messageStart)
    const start = anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    })
    expect(stream.push(start)).toEqual([])
    expect(stream.push(anthropicFrame("content_block_stop", { index: 0 }))).toEqual([])
  })

  test("a text_delta becomes delta.content, one event in and one out", () => {
    const stream = translator()
    stream.push(messageStart)
    const events = stream.push(
      anthropicFrame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }),
    )
    expect(events).toHaveLength(1)
    expect((payloads(events)[0] as Chunk).choices[0]?.delta).toEqual({ content: "hi" })
  })

  test("a text block that opens with text already in it does not lose it", () => {
    const stream = translator()
    stream.push(messageStart)
    const events = stream.push(
      anthropicFrame("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "pre" },
      }),
    )
    expect((payloads(events)[0] as Chunk).choices[0]?.delta).toEqual({ content: "pre" })
  })

  test("ping is dropped", () => {
    expect(translator().push(anthropicFrame("ping"))).toEqual([])
  })

  test("thinking and redacted_thinking deltas are dropped — no openai-chat counterpart", () => {
    const stream = translator()
    stream.push(messageStart)
    stream.push(
      anthropicFrame("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    )
    const events = stream.push(
      anthropicFrame("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
    )
    expect(events).toEqual([])
  })
})

describe("the terminal events", () => {
  test("stop_reason arrives on message_delta, not message_stop", () => {
    const stream = translator()
    stream.push(messageStart)
    const finish = payloads(stream.push(messageDelta("end_turn"))) as Chunk[]
    expect(finish[0]?.choices[0]?.finish_reason).toBe("stop")
    expect(finish[0]?.choices[0]?.delta).toEqual({})
    // message_stop carries nothing but the sentinel; a translator waiting for it finds no reason.
    expect(stream.push(anthropicFrame("message_stop"))).toEqual([{ data: "[DONE]" }])
  })

  test("usage arrives on message_delta too, summed across the three input fields", () => {
    const stream = translator()
    stream.push(messageStart)
    const events = payloads(stream.push(messageDelta("end_turn"))) as Chunk[]
    expect(events).toHaveLength(2)
    expect(events[1]?.choices).toEqual([])
    expect(events[1]?.usage).toEqual({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    })
  })

  test("usage is emitted even though an openai stream omits it without include_usage", () => {
    const stream = anthropicToOpenAiChatStream({ created: CREATED })
    stream.push(messageStart)
    expect(payloads(stream.push(messageDelta("end_turn")))).toHaveLength(2)
  })

  test("a count the upstream never sent is null, never zero", () => {
    const stream = anthropicToOpenAiChatStream({ created: CREATED })
    stream.push(anthropicFrame("message_start", { message: { id: "msg_02", usage: null } }))
    const events = payloads(stream.push(messageDelta("end_turn"))) as Chunk[]
    expect(events[1]?.usage).toEqual({
      prompt_tokens: null,
      completion_tokens: 50,
      total_tokens: 50,
    })
  })

  test("a message_delta stating no usage still emits its finish chunk", () => {
    const stream = anthropicToOpenAiChatStream({ created: CREATED })
    stream.push(
      anthropicFrame("message_start", { message: { id: "msg_04", usage: { input_tokens: 100 } } }),
    )
    const events = payloads(
      stream.push(anthropicFrame("message_delta", { delta: { stop_reason: "end_turn" } })),
    ) as Chunk[]
    expect(events[0]?.choices[0]?.finish_reason).toBe("stop")
    // What message_start stated survives; a count the upstream never sent stays null.
    expect(events[1]?.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: null })
  })

  test("a stream that counted nothing anywhere emits no usage chunk at all", () => {
    const stream = anthropicToOpenAiChatStream({ created: CREATED })
    stream.push(anthropicFrame("message_start", { message: { id: "msg_03" } }))
    const events = stream.push(
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn" } }),
    )
    expect(events).toHaveLength(1)
  })

  test("the full mapped sequence, end to end", () => {
    const { events } = run([
      messageStart,
      ...textBlock("hello"),
      messageDelta("max_tokens"),
      anthropicFrame("message_stop"),
    ])
    const chunks = payloads(events) as Chunk[]
    expect(chunks.map((chunk) => chunk.choices[0]?.delta)).toEqual([
      { role: "assistant", content: "" },
      { content: "hello" },
      {},
      undefined,
    ])
    expect(chunks[2]?.choices[0]?.finish_reason).toBe("length")
    expect(events.at(-1)).toEqual({ data: "[DONE]" })
  })

  test("an unrecognized stop reason maps conservatively and is reported for the caller to log", () => {
    const { events, unrecognized } = run([messageStart, messageDelta("something_new")])
    expect((payloads(events)[1] as Chunk).choices[0]?.finish_reason).toBe("stop")
    expect(unrecognized).toBe("something_new")
  })

  test("nothing is emitted after message_stop", () => {
    const stream = translator()
    stream.push(messageStart)
    stream.push(anthropicFrame("message_stop"))
    expect(
      stream.push(
        anthropicFrame("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "x" },
        }),
      ),
    ).toEqual([])
    expect(stream.flush()).toEqual([])
  })

  test("flush owes the sentinel when message_delta landed but message_stop never did", () => {
    const stream = translator()
    stream.push(messageStart)
    stream.push(messageDelta("end_turn"))
    expect(stream.flush()).toEqual([{ data: "[DONE]" }])
    expect(stream.flush()).toEqual([])
  })

  test("a truncated stream gets no sentinel — a clean finish is never synthesized", () => {
    const stream = translator()
    stream.push(messageStart)
    stream.push(
      anthropicFrame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "par" },
      }),
    )
    expect(stream.flush()).toEqual([])
  })
})

describe("tool calls", () => {
  test("content_block_start (tool_use) carries the id and name onto delta.tool_calls", () => {
    const stream = translator()
    stream.push(messageStart)
    const events = stream.push(
      anthropicFrame("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      }),
    )
    expect((payloads(events)[0] as Chunk).choices[0]?.delta).toEqual({
      tool_calls: [
        {
          index: 0,
          id: "toolu_1",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        },
      ],
    })
  })

  test("input_json_delta becomes function.arguments on the same call index", () => {
    const stream = translator()
    stream.push(messageStart)
    stream.push(
      anthropicFrame("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      }),
    )
    const events = stream.push(
      anthropicFrame("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city"' },
      }),
    )
    expect((payloads(events)[0] as Chunk).choices[0]?.delta).toEqual({
      tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
    })
  })

  test("the openai call index counts calls; the anthropic block index counts every block", () => {
    const stream = translator()
    stream.push(messageStart)
    // Block 0 is text; the two tool blocks are 1 and 2 but must become calls 0 and 1.
    stream.push(
      anthropicFrame("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    )
    const first = stream.push(
      anthropicFrame("content_block_start", {
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "a", input: {} },
      }),
    )
    const second = stream.push(
      anthropicFrame("content_block_start", {
        index: 2,
        content_block: { type: "tool_use", id: "toolu_2", name: "b", input: {} },
      }),
    )
    expect((payloads(first)[0] as Chunk).choices[0]?.delta.tool_calls).toMatchObject([{ index: 0 }])
    expect((payloads(second)[0] as Chunk).choices[0]?.delta.tool_calls).toMatchObject([
      { index: 1 },
    ])
  })

  test("an input_json_delta for a block that never started is dropped, not misattributed", () => {
    const stream = translator()
    stream.push(messageStart)
    const events = stream.push(
      anthropicFrame("content_block_delta", {
        index: 7,
        delta: { type: "input_json_delta", partial_json: "{}" },
      }),
    )
    expect(events).toEqual([])
  })
})

describe("failure mid-stream", () => {
  test("an error event becomes an openai error chunk and closes the stream", () => {
    const stream = translator()
    stream.push(messageStart)
    const events = stream.push(
      anthropicFrame("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
    )
    expect(payloads(events)).toEqual([
      {
        error: {
          message: "Overloaded",
          type: "server_error",
          param: null,
          code: "overloaded_error",
        },
      },
    ])
    // Then the stream is over: no sentinel, and nothing after it.
    expect(stream.push(anthropicFrame("message_stop"))).toEqual([])
    expect(stream.flush()).toEqual([])
  })

  test("a malformed frame is skipped rather than thrown over", () => {
    const stream = translator()
    expect(stream.push({ event: "content_block_delta", data: "{not json" })).toEqual([])
    expect(stream.push({ event: null, data: '{"type":"content_block_delta"}' })).toEqual([])
  })
})
