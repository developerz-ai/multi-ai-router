/**
 * The four pairs touching `openai-responses` — request, non-streaming response, and stream, both
 * directions (docs/idea/06-protocol-translation.md#translation-matrix). The anthropic<->openai-chat
 * pair has its own dedicated files; this one is everything the Responses dialect participates in.
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import type { SseEvent, SseFrame } from "../../../src/services/translate"
import {
  anthropicToOpenAiResponsesRequest,
  anthropicToOpenAiResponsesResponse,
  anthropicToOpenAiResponsesStream,
  openAiChatToOpenAiResponsesRequest,
  openAiChatToOpenAiResponsesResponse,
  openAiChatToOpenAiResponsesStream,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToAnthropicResponse,
  openAiResponsesToAnthropicStream,
  openAiResponsesToOpenAiChatRequest,
  openAiResponsesToOpenAiChatResponse,
  openAiResponsesToOpenAiChatStream,
} from "../../../src/services/translate"
import {
  anthropicRequest,
  anthropicUsageWire,
  openAiChatRequest,
  openAiChatUsageWire,
  openAiResponsesRequest,
  payloads,
  responsesBodyWire,
  responsesFrame,
  responsesFunctionCallItem,
  responsesTextItem,
} from "./fixtures"

const CREATED = 1_700_000_000

/** Feeds a whole recorded stream and returns every event, in order. */
function run(
  stream: {
    push(frame: SseFrame): readonly SseEvent[]
    flush(): readonly SseEvent[]
    unrecognizedStopReason(): string | null
  },
  frames: readonly SseFrame[],
): { events: SseEvent[]; unrecognized: string | null } {
  const events: SseEvent[] = []
  for (const frame of frames) events.push(...stream.push(frame))
  events.push(...stream.flush())
  return { events, unrecognized: stream.unrecognizedStopReason() }
}

describe("anthropic -> openai-responses request", () => {
  test("system becomes instructions, messages become input_text/output_text items", () => {
    const out = anthropicToOpenAiResponsesRequest(
      anthropicRequest({
        system: "be terse",
        messages: [{ role: "user", content: "hi" }],
      }),
    )
    expect(out.instructions).toBe("be terse")
    expect(out.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ])
  })

  test("a turn interleaving text and tool_use splits into separate items, in order", () => {
    const out = anthropicToOpenAiResponsesRequest(
      anthropicRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "let me check" },
              { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "sf" } },
            ],
          },
        ],
      }),
    )
    expect(out.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "let me check" }],
      },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"sf"}' },
    ])
  })

  test("tool_result becomes a function_call_output item", () => {
    const out = anthropicToOpenAiResponsesRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }],
          },
        ],
      }),
    )
    expect(out.input).toEqual([{ type: "function_call_output", call_id: "call_1", output: "72F" }])
  })

  test("consecutive same-role turns are not merged: Responses has no alternation requirement", () => {
    const out = anthropicToOpenAiResponsesRequest(
      anthropicRequest({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    )
    expect(out.input).toHaveLength(2)
  })

  test("store is always false", () => {
    expect(anthropicToOpenAiResponsesRequest(anthropicRequest()).store).toBe(false)
  })

  test("stop_sequences is refused: openai-responses states no stop parameter", () => {
    expect(() =>
      anthropicToOpenAiResponsesRequest(anthropicRequest({ stop_sequences: ["STOP"] })),
    ).toThrow(TranslationError)
  })

  test("an image on an assistant turn is refused: assistant content is output_text/refusal only", () => {
    expect(() =>
      anthropicToOpenAiResponsesRequest(
        anthropicRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
              ],
            },
          ],
        }),
      ),
    ).toThrow(TranslationError)
  })

  test("a tool_use block on a user turn is refused", () => {
    expect(() =>
      anthropicToOpenAiResponsesRequest(
        anthropicRequest({
          messages: [
            { role: "user", content: [{ type: "tool_use", id: "x", name: "n", input: {} }] },
          ],
        }),
      ),
    ).toThrow(TranslationError)
  })

  test("an unrecognized block type is refused, naming the field", () => {
    expect(() =>
      anthropicToOpenAiResponsesRequest(
        anthropicRequest({
          messages: [{ role: "user", content: [{ type: "server_tool_use", id: "x" }] }],
        }),
      ),
    ).toThrow(/messages\[0\]\.content\[0\]\.type/)
  })
})

describe("anthropic -> openai-responses response (non-streaming)", () => {
  test("each anthropic block becomes one output item, in order", () => {
    const out = anthropicToOpenAiResponsesResponse(
      {
        id: "msg_01",
        model: "claude-sonnet-4-5",
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "sf" } },
        ],
        stop_reason: "tool_use",
        usage: anthropicUsageWire(),
      },
      { created: CREATED },
    )
    const body = out.body as { output: unknown[]; status: string }
    expect(body.output).toEqual([
      {
        id: "msg_msg_01_0",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
      {
        id: "fc_msg_01_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"sf"}',
      },
    ])
    expect(body.status).toBe("completed")
  })

  test("an empty text block opens no item", () => {
    const out = anthropicToOpenAiResponsesResponse(
      { id: "msg_01", content: [{ type: "text", text: "" }], stop_reason: "end_turn" },
      { created: CREATED },
    )
    expect((out.body as { output: unknown[] }).output).toEqual([])
  })

  test("a thinking block becomes a reasoning item carrying its summary", () => {
    const out = anthropicToOpenAiResponsesResponse(
      {
        id: "msg_01",
        content: [{ type: "thinking", thinking: "scratch" }],
        stop_reason: "end_turn",
      },
      { created: CREATED },
    )
    expect((out.body as { output: unknown[] }).output).toEqual([
      {
        id: "rs_msg_01_0",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "scratch" }],
      },
    ])
  })

  test("redacted_thinking is dropped: no summary to carry", () => {
    const out = anthropicToOpenAiResponsesResponse(
      {
        id: "msg_01",
        content: [{ type: "redacted_thinking", data: "opaque" }],
        stop_reason: "end_turn",
      },
      { created: CREATED },
    )
    expect((out.body as { output: unknown[] }).output).toEqual([])
  })

  test("max_tokens maps to status incomplete with a reason", () => {
    const out = anthropicToOpenAiResponsesResponse(
      { id: "msg_01", content: [], stop_reason: "max_tokens" },
      { created: CREATED },
    )
    expect(out.body).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    })
  })

  test("usage is null when the upstream counted nothing, never a block of zeroes", () => {
    const out = anthropicToOpenAiResponsesResponse(
      { id: "msg_01", content: [], stop_reason: "end_turn" },
      { created: CREATED },
    )
    expect((out.body as { usage?: unknown }).usage).toBeUndefined()
  })

  test("nothing throws on a malformed body", () => {
    expect(() =>
      anthropicToOpenAiResponsesResponse("not an object", { created: CREATED }),
    ).not.toThrow()
  })
})

describe("anthropic -> openai-responses stream", () => {
  function translator() {
    return anthropicToOpenAiResponsesStream({
      created: CREATED,
      id: "fallback",
      model: "requested",
    })
  }

  test("message_start identifies the response before response.created goes out", () => {
    const events = translator().push(
      responsesFrame("message_start", {
        message: { id: "msg_01", model: "claude-sonnet-4-5", usage: anthropicUsageWire() },
      }),
    )
    const [created] = payloads(events) as { response: { id: string; model: string } }[]
    expect(created?.response.id).toBe("msg_01")
    expect(created?.response.model).toBe("claude-sonnet-4-5")
  })

  test("content_block_stop closes the item, forwarded rather than reconstructed", () => {
    const stream = translator()
    stream.push(responsesFrame("message_start", { message: { id: "msg_01" } }))
    stream.push(
      responsesFrame("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    )
    stream.push(
      responsesFrame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }),
    )
    const events = stream.push(responsesFrame("content_block_stop", { index: 0 }))
    const types = events.map((event) => event.event)
    expect(types).toContain("response.output_item.done")
  })

  test("thinking_delta becomes response.reasoning_summary_text.delta", () => {
    const stream = translator()
    stream.push(responsesFrame("message_start", { message: { id: "msg_01" } }))
    stream.push(
      responsesFrame("content_block_start", { index: 0, content_block: { type: "thinking" } }),
    )
    const events = stream.push(
      responsesFrame("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
    )
    expect(events.map((event) => event.event)).toContain("response.reasoning_summary_text.delta")
  })

  test("stop_reason and usage arrive on message_delta, emitted as response.completed", () => {
    const stream = translator()
    stream.push(responsesFrame("message_start", { message: { id: "msg_01" } }))
    const events = stream.push(
      responsesFrame("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }),
    )
    const payload = payloads(events).find(
      (event) => (event as { type: string }).type === "response.completed",
    ) as { response: { status: string } } | undefined
    expect(payload?.response.status).toBe("completed")
  })

  test("a truncated stream gets no synthesized ending", () => {
    const stream = translator()
    stream.push(responsesFrame("message_start", { message: { id: "msg_01" } }))
    stream.push(
      responsesFrame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }),
    )
    expect(stream.flush()).toEqual([])
  })

  test("an error event terminates the stream via response.failed", () => {
    const stream = translator()
    const events = stream.push(
      responsesFrame("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
    )
    expect(events.map((event) => event.event)).toContain("response.failed")
    expect(stream.push(responsesFrame("message_stop"))).toEqual([])
  })

  test("an unrecognized stop reason is reported for the caller to log", () => {
    const stream = translator()
    stream.push(responsesFrame("message_start", { message: { id: "msg_01" } }))
    stream.push(responsesFrame("message_delta", { delta: { stop_reason: "something_new" } }))
    expect(stream.unrecognizedStopReason()).toBe("something_new")
  })
})

describe("openai-responses -> anthropic request", () => {
  test("instructions becomes the system prompt", () => {
    const out = openAiResponsesToAnthropicRequest(
      openAiResponsesRequest({ instructions: "be terse" }),
    )
    expect(out.system).toBe("be terse")
  })

  test("a bare string input is the shorthand for one user turn", () => {
    const out = openAiResponsesToAnthropicRequest(openAiResponsesRequest({ input: "hello" }))
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }])
  })

  test("function_call / function_call_output pair into a tool_use / tool_result turn", () => {
    const out = openAiResponsesToAnthropicRequest(
      openAiResponsesRequest({
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"sf"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "72F" },
        ],
      }),
    )
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "sf" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }] },
    ])
  })

  test("a function_call_output naming an unseen call_id is refused", () => {
    expect(() =>
      openAiResponsesToAnthropicRequest(
        openAiResponsesRequest({
          input: [{ type: "function_call_output", call_id: "ghost", output: "72F" }],
        }),
      ),
    ).toThrow(TranslationError)
  })

  test("consecutive same-role turns are merged: anthropic requires strict alternation", () => {
    const out = openAiResponsesToAnthropicRequest(
      openAiResponsesRequest({
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    )
    expect(out.messages).toHaveLength(1)
  })

  test("previous_response_id is refused: this router holds no stored response to continue", () => {
    expect(() =>
      openAiResponsesToAnthropicRequest(
        openAiResponsesRequest({ previous_response_id: "resp_abc" }),
      ),
    ).toThrow(TranslationError)
  })

  test("store: true is refused", () => {
    expect(() =>
      openAiResponsesToAnthropicRequest(openAiResponsesRequest({ store: true })),
    ).toThrow(TranslationError)
  })

  test("a reasoning item is refused as stateful", () => {
    expect(() =>
      openAiResponsesToAnthropicRequest(openAiResponsesRequest({ input: [{ type: "reasoning" }] })),
    ).toThrow(TranslationError)
  })

  test("a structured-output text.format is refused", () => {
    expect(() =>
      openAiResponsesToAnthropicRequest(
        openAiResponsesRequest({ text: { format: { type: "json_schema" } } }),
      ),
    ).toThrow(TranslationError)
  })

  test("an absent max_output_tokens falls back to the injected default", () => {
    const out = openAiResponsesToAnthropicRequest(openAiResponsesRequest(), {
      defaultMaxTokens: 2048,
    })
    expect(out.max_tokens).toBe(2048)
  })

  test("an input_image naming only a file_id is refused: no provider-side state to resolve", () => {
    expect(() =>
      openAiResponsesToAnthropicRequest(
        openAiResponsesRequest({
          input: [{ role: "user", content: [{ type: "input_image", file_id: "file_1" }] }],
        }),
      ),
    ).toThrow(TranslationError)
  })
})

describe("openai-responses -> anthropic response (non-streaming)", () => {
  test("text and function_call items become text and tool_use blocks, in order", () => {
    const out = openAiResponsesToAnthropicResponse(
      responsesBodyWire({
        output: [responsesTextItem("hello"), responsesFunctionCallItem()],
      }),
      {},
    )
    expect(out.body).toMatchObject({
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "sf" } },
      ],
    })
  })

  test("a reasoning item is dropped: no signature this router can mint", () => {
    const out = openAiResponsesToAnthropicResponse(
      responsesBodyWire({
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "scratch" }] },
        ],
      }),
      {},
    )
    expect((out.body as { content: unknown[] }).content).toEqual([])
  })

  test("a function_call decides the stop reason even when status alone would not", () => {
    const out = openAiResponsesToAnthropicResponse(
      responsesBodyWire({ status: "completed", output: [responsesFunctionCallItem()] }),
      {},
    )
    expect((out.body as { stop_reason: string }).stop_reason).toBe("tool_use")
  })

  test("incomplete/max_output_tokens maps to stop_reason max_tokens", () => {
    const out = openAiResponsesToAnthropicResponse(
      responsesBodyWire({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      }),
      {},
    )
    expect((out.body as { stop_reason: string }).stop_reason).toBe("max_tokens")
  })

  test("nothing throws on a malformed body", () => {
    expect(() => openAiResponsesToAnthropicResponse("not an object", {})).not.toThrow()
  })
})

describe("openai-responses -> anthropic stream", () => {
  function translator() {
    return openAiResponsesToAnthropicStream({ id: "fallback", model: "requested" })
  }

  test("response.created identifies the stream and opens message_start", () => {
    const events = translator().push(
      responsesFrame("response.created", { response: { id: "resp_01", model: "gpt-5" } }),
    )
    const [start] = payloads(events) as { message: { id: string; model: string } }[]
    expect(start?.message.id).toBe("resp_01")
    expect(start?.message.model).toBe("gpt-5")
  })

  test("response.output_item.added (function_call) opens a tool_use block", () => {
    const stream = translator()
    stream.push(responsesFrame("response.created", { response: { id: "resp_01" } }))
    const events = stream.push(
      responsesFrame("response.output_item.added", {
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "get_weather" },
      }),
    )
    const [block] = payloads(events) as { content_block: { type: string; name: string } }[]
    expect(block?.content_block.type).toBe("tool_use")
    expect(block?.content_block.name).toBe("get_weather")
  })

  test("response.output_item.done closes the open block", () => {
    const stream = translator()
    stream.push(responsesFrame("response.created", { response: { id: "resp_01" } }))
    stream.push(responsesFrame("response.output_text.delta", { delta: "hi" }))
    const events = stream.push(responsesFrame("response.output_item.done", {}))
    expect(events.map((event) => event.event)).toContain("content_block_stop")
  })

  test("response.completed carries the stop reason and usage, terminating the stream", () => {
    const stream = translator()
    stream.push(responsesFrame("response.created", { response: { id: "resp_01" } }))
    const events = stream.push(
      responsesFrame("response.completed", {
        response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    )
    const types = events.map((event) => event.event)
    expect(types).toContain("message_delta")
    expect(types).toContain("message_stop")
  })

  test("response.failed becomes an anthropic error event", () => {
    const stream = translator()
    const events = stream.push(
      responsesFrame("response.failed", { response: { error: { message: "boom" } } }),
    )
    expect(events.map((event) => event.event)).toContain("error")
  })

  test("a truncated stream gets no synthesized ending", () => {
    const stream = translator()
    stream.push(responsesFrame("response.created", { response: { id: "resp_01" } }))
    stream.push(responsesFrame("response.output_text.delta", { delta: "partial" }))
    expect(stream.flush()).toEqual([])
  })
})

describe("openai-chat -> openai-responses request", () => {
  test("system/developer messages join into instructions", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({
        messages: [
          { role: "system", content: "first" },
          { role: "user", content: "hi" },
        ],
      }),
    )
    expect(out.instructions).toBe("first")
  })

  test("an assistant message with tool_calls yields a message item plus a function_call item", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({
        messages: [
          {
            role: "assistant",
            content: "checking",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
        ],
      }),
    )
    expect(out.input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
    ])
  })

  test("consecutive same-role messages stay separate items: no alternation requirement", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    )
    expect(out.input).toHaveLength(2)
  })

  test("logprobs is refused: no openai-responses counterpart", () => {
    expect(() => openAiChatToOpenAiResponsesRequest(openAiChatRequest({ logprobs: true }))).toThrow(
      TranslationError,
    )
  })

  test("n > 1 is refused: one request yields exactly one response", () => {
    expect(() => openAiChatToOpenAiResponsesRequest(openAiChatRequest({ n: 2 }))).toThrow(
      TranslationError,
    )
  })

  test("a tool message answering an unseen call is refused", () => {
    expect(() =>
      openAiChatToOpenAiResponsesRequest(
        openAiChatRequest({ messages: [{ role: "tool", tool_call_id: "ghost", content: "72F" }] }),
      ),
    ).toThrow(TranslationError)
  })

  test("store is always false", () => {
    expect(openAiChatToOpenAiResponsesRequest(openAiChatRequest()).store).toBe(false)
  })
})

describe("openai-chat -> openai-responses response (non-streaming)", () => {
  test("content becomes a message item, tool_calls become function_call items, in order", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      {
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              content: "hello",
              tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: openAiChatUsageWire(),
      },
      { created: CREATED },
    )
    expect((out.body as { output: unknown[] }).output).toEqual([
      {
        id: "msg_chatcmpl-1_0",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
      {
        id: "fc_chatcmpl-1_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "get_weather",
        arguments: "{}",
      },
    ])
  })

  test("a tool-call-only completion emits no message item", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      {
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { content: null, tool_calls: [] }, finish_reason: "stop" }],
      },
      { created: CREATED },
    )
    expect((out.body as { output: unknown[] }).output).toEqual([])
  })

  test("only the first choice survives: n > 1 is refused at request time", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      {
        id: "chatcmpl-1",
        choices: [
          { index: 0, message: { content: "first" }, finish_reason: "stop" },
          { index: 1, message: { content: "second" }, finish_reason: "stop" },
        ],
      },
      { created: CREATED },
    )
    expect((out.body as { output: { text?: string }[] }).output).toHaveLength(1)
  })

  test("nothing throws on a malformed body", () => {
    expect(() => openAiChatToOpenAiResponsesResponse(null, { created: CREATED })).not.toThrow()
  })
})

describe("openai-chat -> openai-responses stream", () => {
  function translator() {
    return openAiChatToOpenAiResponsesStream({
      created: CREATED,
      id: "fallback",
      model: "requested",
    })
  }

  test("the first chunk identifies the stream and opens response.created", () => {
    const events = translator().push({
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
    })
    const created = payloads(events).find(
      (event) => (event as { type: string }).type === "response.created",
    ) as { response: { id: string; model: string } } | undefined
    expect(created?.response.id).toBe("chatcmpl-1")
    expect(created?.response.model).toBe("gpt-4o")
  })

  test("delta.content becomes a text item", () => {
    const stream = translator()
    const events = stream.push({
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      }),
    })
    expect(events.map((event) => event.event)).toContain("response.output_text.delta")
  })

  test("delta.tool_calls opens a function_call item keyed by its index", () => {
    const stream = translator()
    const events = stream.push({
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather" } }] },
            finish_reason: null,
          },
        ],
      }),
    })
    expect(events.map((event) => event.event)).toContain("response.output_item.added")
  })

  test("finish_reason closes the item; usage and [DONE] wait for the terminal chunk", () => {
    const stream = translator()
    stream.push({
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      }),
    })
    const events = stream.push({ event: null, data: "[DONE]" })
    const types = payloads(events).map((event) => (event as { type: string }).type)
    expect(types).toContain("response.completed")
  })

  test("a stream that ends with no finish_reason is truncated: flush emits nothing", () => {
    const stream = translator()
    stream.push({
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      }),
    })
    expect(stream.flush()).toEqual([])
  })

  /**
   * The `tool_calls[].index` a compatible upstream may revisit, or never send at all — the same
   * looseness `stream-openai-anthropic.test.ts` covers toward Anthropic, and the same silent
   * truncation of `arguments` if the reader keeps only the item it opened last.
   */
  describe("tool calls the upstream keys loosely", () => {
    const chunk = (calls: Record<string, unknown>[]): SseFrame => ({
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }],
      }),
    })
    const finish: SseFrame = {
      event: null,
      data: JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    }

    /** The finished `function_call` items, which is what a Responses client actually executes. */
    function calls(events: readonly SseEvent[]): { name: string; arguments: string }[] {
      const completed = payloads(events).find(
        (event) => (event as { type: string }).type === "response.completed",
      ) as { response: { output: { type: string; name: string; arguments: string }[] } } | undefined
      return (completed?.response.output ?? [])
        .filter((item) => item.type === "function_call")
        .map((item) => ({ name: item.name, arguments: item.arguments }))
    }

    function run(frames: readonly SseFrame[]): SseEvent[] {
      const stream = translator()
      const events: SseEvent[] = []
      for (const frame of frames) events.push(...stream.push(frame))
      events.push(...stream.flush())
      return events
    }

    test("arguments revisiting an earlier index after a later call opened still arrive", () => {
      const events = run([
        chunk([
          { index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } },
          { index: 1, id: "call_2", function: { name: "lookup", arguments: "" } },
        ]),
        chunk([{ index: 0, function: { arguments: '{"city":"NY"}' } }]),
        chunk([{ index: 1, function: { arguments: '{"q":"x"}' } }]),
        finish,
        { event: null, data: "[DONE]" },
      ])
      expect(calls(events)).toEqual([
        { name: "get_weather", arguments: '{"city":"NY"}' },
        { name: "lookup", arguments: '{"q":"x"}' },
      ])
    })

    test("calls that state no index at all stay distinct rather than collapsing into one", () => {
      const events = run([
        chunk([{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"NY"}' } }]),
        chunk([{ id: "call_2", function: { name: "lookup", arguments: '{"q":"x"}' } }]),
        finish,
        { event: null, data: "[DONE]" },
      ])
      expect(calls(events)).toEqual([
        { name: "get_weather", arguments: '{"city":"NY"}' },
        { name: "lookup", arguments: '{"q":"x"}' },
      ])
    })

    test("a held item is announced and closed like any other, never overlapping the live one", () => {
      const events = run([
        chunk([
          { index: 0, id: "call_1", function: { name: "get_weather", arguments: "{}" } },
          { index: 1, id: "call_2", function: { name: "lookup", arguments: "{}" } },
        ]),
        finish,
        { event: null, data: "[DONE]" },
      ])
      const names = events
        .map((event) => event.event)
        .filter(
          (name) => name === "response.output_item.added" || name === "response.output_item.done",
        )
      expect(names).toEqual([
        "response.output_item.added",
        "response.output_item.done",
        "response.output_item.added",
        "response.output_item.done",
      ])
    })
  })
})

describe("openai-responses -> openai-chat request (the downgrade)", () => {
  test("instructions become a leading system message", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({ instructions: "be terse" }),
    )
    expect(out.messages[0]).toEqual({ role: "system", content: "be terse" })
  })

  test("a bare string input is one user message", () => {
    const out = openAiResponsesToOpenAiChatRequest(openAiResponsesRequest({ input: "hello" }))
    expect(out.messages).toEqual([{ role: "user", content: "hello" }])
  })

  test("function_call / function_call_output pair into an assistant tool_calls turn and a tool turn", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({
        input: [
          { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "72F" },
        ],
      }),
    )
    expect(out.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "72F" },
    ])
  })

  test("consecutive same-role items stay separate: each is already exactly one message", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    )
    expect(out.messages).toHaveLength(2)
  })

  test("previous_response_id is refused before any upstream call", () => {
    expect(() =>
      openAiResponsesToOpenAiChatRequest(
        openAiResponsesRequest({ previous_response_id: "resp_abc" }),
      ),
    ).toThrow(TranslationError)
  })

  test("a reasoning item is refused as stateful", () => {
    expect(() =>
      openAiResponsesToOpenAiChatRequest(
        openAiResponsesRequest({ input: [{ type: "reasoning" }] }),
      ),
    ).toThrow(TranslationError)
  })

  test("an input_image naming only a file_id is refused", () => {
    expect(() =>
      openAiResponsesToOpenAiChatRequest(
        openAiResponsesRequest({
          input: [{ role: "user", content: [{ type: "input_image", file_id: "file_1" }] }],
        }),
      ),
    ).toThrow(TranslationError)
  })

  test("stream requests include_usage: an omitted count would leave the terminal chunk null forever", () => {
    const out = openAiResponsesToOpenAiChatRequest(openAiResponsesRequest({ stream: true }))
    expect(out.stream_options).toEqual({ include_usage: true })
  })

  test("max_output_tokens lands under max_tokens by default", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({ max_output_tokens: 512 }),
    )
    expect(out.max_tokens).toBe(512)
    expect(out).not.toHaveProperty("max_completion_tokens")
  })

  test("max_output_tokens lands under max_completion_tokens where the account states that name", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({ max_output_tokens: 512 }),
      { ceiling: "max_completion_tokens" },
    )
    expect(out.max_completion_tokens).toBe(512)
    expect(out).not.toHaveProperty("max_tokens")
  })

  test("an absent max_output_tokens emits neither name: openai-chat's ceiling is optional", () => {
    const out = JSON.parse(
      JSON.stringify(
        openAiResponsesToOpenAiChatRequest(openAiResponsesRequest(), {
          ceiling: "max_completion_tokens",
        }),
      ),
    )
    expect(out).not.toHaveProperty("max_tokens")
    expect(out).not.toHaveProperty("max_completion_tokens")
  })
})

describe("openai-responses -> openai-chat response (the downgrade)", () => {
  test("message items concatenate into content, function_call items become tool_calls", () => {
    const out = openAiResponsesToOpenAiChatResponse(
      responsesBodyWire({ output: [responsesTextItem("hello"), responsesFunctionCallItem()] }),
      { created: CREATED },
    )
    expect(out.body).toMatchObject({
      choices: [
        {
          message: {
            content: "hello",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"sf"}' },
              },
            ],
          },
        },
      ],
    })
  })

  test("a tool-call-only response states content: null, not an empty string", () => {
    const out = openAiResponsesToOpenAiChatResponse(
      responsesBodyWire({ output: [responsesFunctionCallItem()] }),
      { created: CREATED },
    )
    expect(
      (out.body as { choices: { message: { content: unknown } }[] }).choices[0]?.message.content,
    ).toBeNull()
  })

  test("a reasoning item is dropped: no reasoning-summary field on openai-chat", () => {
    const out = openAiResponsesToOpenAiChatResponse(
      responsesBodyWire({
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "scratch" }] },
        ],
      }),
      { created: CREATED },
    )
    expect(
      (out.body as { choices: { message: { content: unknown } }[] }).choices[0]?.message.content,
    ).toBeNull()
  })

  test("a function_call decides finish_reason: tool_calls, not merely status", () => {
    const out = openAiResponsesToOpenAiChatResponse(
      responsesBodyWire({ status: "completed", output: [responsesFunctionCallItem()] }),
      { created: CREATED },
    )
    expect((out.body as { choices: { finish_reason: string }[] }).choices[0]?.finish_reason).toBe(
      "tool_calls",
    )
  })

  test("usage is omitted, not zeroed, when the upstream counted nothing", () => {
    const out = openAiResponsesToOpenAiChatResponse(responsesBodyWire({ output: [] }), {
      created: CREATED,
    })
    expect(out.body).not.toHaveProperty("usage")
  })
})

describe("openai-responses -> openai-chat stream (the downgrade)", () => {
  function translator() {
    return openAiResponsesToOpenAiChatStream({
      created: CREATED,
      id: "fallback",
      model: "requested",
    })
  }

  test("response.created emits the opening role chunk with the upstream's own id/model", () => {
    const events = translator().push(
      responsesFrame("response.created", { response: { id: "resp_01", model: "gpt-5" } }),
    )
    const [chunk] = payloads(events) as {
      id: string
      model: string
      choices: { delta: unknown }[]
    }[]
    expect(chunk?.id).toBe("resp_01")
    expect(chunk?.model).toBe("gpt-5")
    expect(chunk?.choices[0]?.delta).toEqual({ role: "assistant", content: "" })
  })

  test("response.output_text.delta becomes delta.content", () => {
    const events = translator().push(responsesFrame("response.output_text.delta", { delta: "hi" }))
    const [chunk] = payloads(events) as { choices: { delta: { content: string } }[] }[]
    expect(chunk?.choices[0]?.delta.content).toBe("hi")
  })

  test("a function_call item's added event opens a tool_calls entry keyed by a call ordinal", () => {
    const stream = translator()
    const events = stream.push(
      responsesFrame("response.output_item.added", {
        output_index: 3,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather" },
      }),
    )
    const [chunk] = payloads(events) as {
      choices: { delta: { tool_calls: { index: number }[] } }[]
    }[]
    // Responses numbers all items (this is output_index 3); openai-chat's index counts only calls.
    expect(chunk?.choices[0]?.delta.tool_calls[0]?.index).toBe(0)
  })

  test("arguments for an item never announced are dropped, not misattributed", () => {
    const events = translator().push(
      responsesFrame("response.function_call_arguments.delta", { item_id: "ghost", delta: "{}" }),
    )
    expect(events).toEqual([])
  })

  test("response.completed emits the terminal chunk, then [DONE]", () => {
    const stream = translator()
    const events = stream.push(
      responsesFrame("response.completed", { response: { status: "completed" } }),
    )
    expect(events.at(-1)).toEqual({ data: "[DONE]" })
  })

  test("a truncated stream gets no synthesized [DONE]", () => {
    const stream = translator()
    stream.push(responsesFrame("response.output_text.delta", { delta: "partial" }))
    expect(stream.flush()).toEqual([])
  })

  test("response.failed renders an openai-chat error body and closes the stream", () => {
    const stream = translator()
    const events = stream.push(
      responsesFrame("response.failed", { response: { error: { message: "boom" } } }),
    )
    expect(events).toHaveLength(1)
    expect(stream.push(responsesFrame("response.completed", {}))).toEqual([])
  })
})

describe("round trip through the full mapped sequence", () => {
  test("anthropic -> openai-responses stream: message_start through message_stop", () => {
    const stream = anthropicToOpenAiResponsesStream({ created: CREATED })
    const { events } = run(stream, [
      responsesFrame("message_start", { message: { id: "msg_01", model: "claude-sonnet-4-5" } }),
      responsesFrame("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      responsesFrame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }),
      responsesFrame("content_block_stop", { index: 0 }),
      responsesFrame("message_delta", {
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      }),
      responsesFrame("message_stop"),
    ])
    const types = payloads(events).map((event) => (event as { type: string }).type)
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
  })

  test("openai-responses -> openai-chat stream: created through [DONE]", () => {
    const stream = openAiResponsesToOpenAiChatStream({ created: CREATED })
    const { events } = run(stream, [
      responsesFrame("response.created", { response: { id: "resp_01", model: "gpt-5" } }),
      responsesFrame("response.output_text.delta", { delta: "hi" }),
      responsesFrame("response.completed", { response: { status: "completed" } }),
    ])
    expect(events.at(-1)).toEqual({ data: "[DONE]" })
    // response.created -> the opening chunk; output_text.delta -> one content chunk; response.completed
    // -> the terminal chunk plus the [DONE] sentinel.
    expect(events).toHaveLength(4)
  })
})
