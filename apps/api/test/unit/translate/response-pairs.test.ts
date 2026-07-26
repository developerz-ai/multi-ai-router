/**
 * The non-streaming `anthropic <-> openai-chat` response pair.
 *
 * `matrix.test.ts` only smoke-tests that every pair's `response()` returns a truthy body for one
 * minimal, well-formed upstream reply — it says nothing about `tool_calls -> tool_use`, `content:
 * null`, which choice a multi-choice reply resolves to, or what a malformed body degrades to. Those
 * are this file's job for the two response translators of the six that had zero unit tests of their
 * own: `anthropic-to-openai-chat/response.ts` and `openai-chat-to-anthropic/response.ts`.
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatResponse,
  openAiChatToAnthropicResponse,
} from "../../../src/services/translate"
import { anthropicUsageWire, openAiChatUsageWire } from "./fixtures"

const CREATED = 1_700_000_000

describe("anthropic -> openai-chat response", () => {
  const translate = (body: unknown) =>
    anthropicToOpenAiChatResponse(body, { created: CREATED, id: "fallback", model: "requested" })

  test("a tool_use block becomes tool_calls, arguments stringified from input", () => {
    const out = translate({
      id: "msg_01",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NY" } }],
      stop_reason: "tool_use",
    })
    const message = (out.body as { choices: { message: unknown }[] }).choices[0]?.message as {
      content: unknown
      tool_calls: unknown[]
    }
    expect(message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"NY"}' },
      },
    ])
  })

  test("a completion carrying only tool calls states content: null, never an empty string", () => {
    const out = translate({
      content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }],
      stop_reason: "tool_use",
    })
    const message = (out.body as { choices: { message: { content: unknown } }[] }).choices[0]
      ?.message
    expect(message?.content).toBeNull()
  })

  test("text and a tool call in the same turn both survive: joined text, and tool_calls alongside it", () => {
    const out = translate({
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "sf" } },
      ],
      stop_reason: "tool_use",
    })
    const message = (
      out.body as { choices: { message: { content: unknown; tool_calls: unknown[] } }[] }
    ).choices[0]?.message
    expect(message?.content).toBe("let me check")
    expect(message?.tool_calls).toHaveLength(1)
  })

  test("multiple text blocks concatenate with no separator, the same as the streaming half", () => {
    const out = translate({
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
      stop_reason: "end_turn",
    })
    const message = (out.body as { choices: { message: { content: unknown } }[] }).choices[0]
      ?.message
    expect(message?.content).toBe("hello world")
  })

  test("thinking and redacted_thinking blocks are dropped, not surfaced as text", () => {
    const out = translate({
      content: [
        { type: "thinking", thinking: "reasoning about it" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "the answer" },
      ],
      stop_reason: "end_turn",
    })
    const message = (out.body as { choices: { message: { content: unknown } }[] }).choices[0]
      ?.message
    expect(message?.content).toBe("the answer")
  })

  test("usage is mapped through the three-field sum, and omitted entirely when the upstream sent none", () => {
    const withUsage = translate({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: anthropicUsageWire(),
    })
    expect((withUsage.body as { usage: unknown }).usage).toEqual({
      prompt_tokens: 130,
      completion_tokens: 50,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 20 },
    })

    const withoutUsage = translate({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
    })
    expect(withoutUsage.body).not.toHaveProperty("usage")
  })

  test("stop_reason maps to finish_reason, and an unrecognized one falls back conservatively", () => {
    const known = translate({ content: [], stop_reason: "max_tokens" })
    expect(
      (known.body as { choices: { finish_reason: unknown }[] }).choices[0]?.finish_reason,
    ).toBe("length")
    expect(known.unrecognizedStopReason).toBeNull()

    const unknown = translate({ content: [], stop_reason: "something_new" })
    expect(
      (unknown.body as { choices: { finish_reason: unknown }[] }).choices[0]?.finish_reason,
    ).toBe("stop")
    expect(unknown.unrecognizedStopReason).toBe("something_new")
  })

  test("ids and model pass through verbatim; the caller's fallbacks stand in when the body names none", () => {
    const named = translate({
      id: "msg_01",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
    })
    expect((named.body as { id: string; model: string }).id).toBe("msg_01")
    expect((named.body as { id: string; model: string }).model).toBe("claude-opus-5")

    const unnamed = translate({ content: [], stop_reason: null })
    expect((unnamed.body as { id: string; model: string }).id).toBe("fallback")
    expect((unnamed.body as { id: string; model: string }).model).toBe("requested")
  })

  test("a malformed body degrades to empty defaults rather than throwing", () => {
    for (const malformed of [
      null,
      undefined,
      "a bare string",
      42,
      [],
      { content: "not an array" },
    ]) {
      const out = translate(malformed)
      const body = out.body as {
        id: string
        model: string
        choices: { message: { content: unknown }; finish_reason: unknown }[]
      }
      expect(body.id).toBe("fallback")
      expect(body.model).toBe("requested")
      expect(body.choices[0]?.message.content).toBeNull()
      expect(body.choices[0]?.finish_reason).toBeNull()
    }
  })
})

describe("openai-chat -> anthropic response", () => {
  const translate = (body: unknown) =>
    openAiChatToAnthropicResponse(body, { id: "fallback", model: "requested" })

  test("tool_calls become tool_use blocks, input parsed from the arguments JSON", () => {
    const out = translate({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", function: { name: "get_weather", arguments: '{"city":"NY"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    expect((out.body as { content: unknown }).content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NY" } },
    ])
  })

  test("content: null with no tool_calls becomes an empty content array — Anthropic rejects an empty text block", () => {
    const out = translate({
      choices: [{ index: 0, message: { content: null, tool_calls: null }, finish_reason: "stop" }],
    })
    expect((out.body as { content: unknown }).content).toEqual([])
  })

  test("text ahead of tool calls, in the order the wire stated them", () => {
    const out = translate({
      choices: [
        {
          index: 0,
          message: {
            content: "checking now",
            tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    expect(
      (out.body as { content: { type: string }[] }).content.map((block) => block.type),
    ).toEqual(["text", "tool_use"])
  })

  test("undecodable arguments become an empty input object, not a thrown error", () => {
    const out = translate({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [{ id: "call_1", function: { name: "broken", arguments: "{not json" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
    expect((out.body as { content: { input: unknown }[] }).content[0]?.input).toEqual({})
  })

  test("arguments that decode to an array or a scalar also fall back to an empty object", () => {
    for (const args of ['["a","b"]', '"just a string"', "42"]) {
      const out = translate({
        choices: [
          {
            index: 0,
            message: {
              content: null,
              tool_calls: [{ id: "call_1", function: { name: "f", arguments: args } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
      expect((out.body as { content: { input: unknown }[] }).content[0]?.input).toEqual({})
    }
  })

  test("choice-index selection: the choice naming index 0 wins regardless of array order", () => {
    const out = translate({
      choices: [
        { index: 1, message: { content: "second" }, finish_reason: "stop" },
        { index: 0, message: { content: "first" }, finish_reason: "stop" },
      ],
    })
    expect((out.body as { content: { text: string }[] }).content[0]?.text).toBe("first")
  })

  test("a choice naming no index at all is treated as index 0", () => {
    const out = translate({
      choices: [{ message: { content: "unindexed" }, finish_reason: "stop" }],
    })
    expect((out.body as { content: { text: string }[] }).content[0]?.text).toBe("unindexed")
  })

  test("n > 1 extras are dropped entirely, never interleaved with index 0's content", () => {
    const out = translate({
      choices: [
        { index: 0, message: { content: "kept" }, finish_reason: "stop" },
        { index: 1, message: { content: "dropped" }, finish_reason: "stop" },
        { index: 2, message: { content: "also dropped" }, finish_reason: "stop" },
      ],
    })
    expect((out.body as { content: { text: string }[] }).content).toHaveLength(1)
    expect((out.body as { content: { text: string }[] }).content[0]?.text).toBe("kept")
  })

  test("no choice naming index 0 leaves the response with no content and no thrown error", () => {
    const out = translate({
      choices: [{ index: 1, message: { content: "not it" }, finish_reason: "stop" }],
    })
    expect((out.body as { content: unknown }).content).toEqual([])
  })

  test("usage is summed through the anthropic shape, cache_read carrying the cached count", () => {
    const out = translate({
      choices: [{ index: 0, message: { content: "hi" }, finish_reason: "stop" }],
      usage: openAiChatUsageWire(),
    })
    expect((out.body as { usage: unknown }).usage).toEqual({
      input_tokens: 110,
      output_tokens: 50,
      cache_read_input_tokens: 20,
    })
  })

  test("stop_sequence is always null: openai-chat names no field for which sequence matched", () => {
    const out = translate({
      choices: [{ index: 0, message: { content: "hi" }, finish_reason: "stop" }],
    })
    expect((out.body as { stop_sequence: unknown }).stop_sequence).toBeNull()
  })

  test("finish_reason maps to stop_reason, and an unrecognized one falls back conservatively", () => {
    const known = translate({ choices: [{ index: 0, message: {}, finish_reason: "length" }] })
    expect((known.body as { stop_reason: unknown }).stop_reason).toBe("max_tokens")
    expect(known.unrecognizedStopReason).toBeNull()

    const unknown = translate({ choices: [{ index: 0, message: {}, finish_reason: "banana" }] })
    expect((unknown.body as { stop_reason: unknown }).stop_reason).toBe("end_turn")
    expect(unknown.unrecognizedStopReason).toBe("banana")
  })

  test("ids and model pass through verbatim; the caller's fallbacks stand in when the body names none", () => {
    const named = translate({ id: "chatcmpl-1", model: "gpt-4o", choices: [] })
    expect((named.body as { id: string; model: string }).id).toBe("chatcmpl-1")
    expect((named.body as { id: string; model: string }).model).toBe("gpt-4o")

    const unnamed = translate({ choices: [] })
    expect((unnamed.body as { id: string; model: string }).id).toBe("fallback")
    expect((unnamed.body as { id: string; model: string }).model).toBe("requested")
  })

  test("a malformed body degrades to empty defaults rather than throwing", () => {
    for (const malformed of [
      null,
      undefined,
      "a bare string",
      42,
      [],
      { choices: "not an array" },
    ]) {
      const out = translate(malformed)
      const body = out.body as {
        id: string
        model: string
        content: unknown[]
        stop_reason: unknown
      }
      expect(body.id).toBe("fallback")
      expect(body.model).toBe("requested")
      expect(body.content).toEqual([])
      expect(body.stop_reason).toBeNull()
    }
  })

  test("no options supplied at all: the id and model default to empty strings", () => {
    const out = openAiChatToAnthropicResponse({ choices: [] })
    expect((out.body as { id: string; model: string }).id).toBe("")
    expect((out.body as { id: string; model: string }).model).toBe("")
  })
})
