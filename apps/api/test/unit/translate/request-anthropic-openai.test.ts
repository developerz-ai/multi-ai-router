/**
 * `POST /v1/messages` → Chat Completions, fixture-driven
 * (docs/idea/06-protocol-translation.md#messages-array).
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import { anthropicToOpenAiChatRequest, type TranslationDrop } from "../../../src/services/translate"
import { anthropicRequest, anthropicTool } from "./fixtures"

describe("sampling parameters and passthrough fields", () => {
  test("carries model, max_tokens, temperature, top_p, stop_sequences, stream", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ["STOP"],
        stream: true,
      }),
    )
    expect(out.model).toBe("claude-sonnet-4-5")
    expect(out.max_tokens).toBe(1024)
    expect(out.temperature).toBe(0.5)
    expect(out.top_p).toBe(0.9)
    expect(out.stop).toEqual(["STOP"])
    expect(out.stream).toBe(true)
  })

  test("sets stream_options.include_usage only when streaming", () => {
    expect(anthropicToOpenAiChatRequest(anthropicRequest({ stream: true })).stream_options).toEqual(
      { include_usage: true },
    )
    expect(anthropicToOpenAiChatRequest(anthropicRequest()).stream_options).toBeUndefined()
  })

  test("top_k is dropped: no openai-chat field carries it", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest({ top_k: 40 }))
    expect(out).not.toHaveProperty("top_k")
  })
})

/**
 * One ceiling, two field names, and no upstream takes both — the target's driver says which one
 * (`OpenAiChatCeiling`). Anthropic *requires* `max_tokens` on the way in, so this direction always
 * carries a ceiling and there is no absent case to fall back for.
 */
describe("the output ceiling", () => {
  test("takes max_tokens by default: the name every compatible vendor states", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest())
    expect(out.max_tokens).toBe(1024)
    expect(out).not.toHaveProperty("max_completion_tokens")
  })

  test("takes max_completion_tokens where the account's provider states that name", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest(), {
      ceiling: "max_completion_tokens",
    })
    expect(out.max_completion_tokens).toBe(1024)
    expect(out).not.toHaveProperty("max_tokens")
  })

  test("never emits both: OpenAI refuses max_tokens beside it on a reasoning model", () => {
    for (const ceiling of ["max_tokens", "max_completion_tokens"] as const) {
      const out = anthropicToOpenAiChatRequest(anthropicRequest(), { ceiling })
      const named = ["max_tokens", "max_completion_tokens"].filter((field) =>
        Object.hasOwn(out, field),
      )
      expect(named).toEqual([ceiling])
    }
  })
})

describe("system prompt", () => {
  test("a string system becomes a leading role:system message", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest({ system: "be terse" }))
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "be terse",
      tool_calls: undefined,
      tool_call_id: undefined,
    })
  })

  test("a text-block array system is concatenated, and the split is not reconstructed", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        system: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    )
    expect(out.messages[0]?.content).toBe("first\n\nsecond")
  })

  test("no system field emits no leading message", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest())
    expect(out.messages[0]?.role).toBe("user")
  })
})

describe("content blocks", () => {
  test("a base64 image becomes a data: URI", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ])
  })

  test("a url image source is carried as-is, never fetched", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ])
  })

  test("thinking and redacted_thinking blocks are dropped, not re-sent", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "scratch" },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.content).toBe("answer")
  })

  test("a non-text document block is dropped and reported by name, never a 400", () => {
    const drops: TranslationDrop[] = []
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see attached" },
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: "x" },
              },
            ],
          },
        ],
      }),
      { onDrop: (drop) => void drops.push(drop) },
    )
    expect(out.messages[0]?.content).toBe("see attached")
    expect(drops).toEqual([
      { field: "messages[0].content[1]", reason: expect.stringContaining("application/pdf") },
    ])
  })

  test("a text-source document travels as text", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "text", media_type: "text/plain", data: "the spec" },
              },
            ],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toBe("the spec")
  })

  test("an unrecognized block type is dropped and reported, naming the field", () => {
    const drops: TranslationDrop[] = []
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "server_tool_use", id: "x" },
              { type: "text", text: "kept" },
            ],
          },
        ],
      }),
      { onDrop: (drop) => void drops.push(drop) },
    )
    expect(out.messages[0]?.content).toBe("kept")
    expect(drops[0]?.field).toBe("messages[0].content[0]")
    expect(drops[0]?.reason).toContain("server_tool_use")
  })

  test("a turn whose every block was dropped is omitted, not sent empty", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          { role: "user", content: [{ type: "server_tool_use", id: "x" }] },
          { role: "user", content: "next" },
        ],
      }),
    )
    expect(out.messages).toHaveLength(1)
  })
})

describe("tool_use and tool_result", () => {
  test("tool_use becomes a tool_calls entry with stringified arguments", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "sf" } },
            ],
          },
        ],
      }),
    )
    expect(out.messages[0]?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"sf"}' },
      },
    ])
  })

  test("a tool_use block on a user turn is rejected: openai-chat cannot express it", () => {
    expect(() =>
      anthropicToOpenAiChatRequest(
        anthropicRequest({
          messages: [
            { role: "user", content: [{ type: "tool_use", id: "x", name: "n", input: {} }] },
          ],
        }),
      ),
    ).toThrow(TranslationError)
  })

  test("tool_result becomes its own role:tool message, positioned after the call", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "72F" }],
          },
        ],
      }),
    )
    expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool"])
    expect(out.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "72F" })
  })

  test("is_error folds into the text with a prefix: no openai field carries it", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true },
            ],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toBe("Error: boom")
  })

  test("an array tool_result content joins its text blocks", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [
                  { type: "text", text: "line one" },
                  { type: "text", text: "line two" },
                ],
              },
            ],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toBe("line one\n\nline two")
  })

  test("an image inside a tool_result is hoisted into a user turn after the tool message", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [
                  { type: "text", text: "screenshot" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
                ],
              },
              { type: "text", text: "what do you see?" },
            ],
          },
        ],
      }),
    )
    expect(out.messages.map((message) => message.role)).toEqual(["tool", "user"])
    expect(out.messages[0]).toMatchObject({ tool_call_id: "call_1", content: "screenshot" })
    // The hoisted image and the rest of the user turn fold into one message, image first.
    expect(out.messages[1]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
      { type: "text", text: "what do you see?" },
    ])
  })

  test("a nested block a tool result cannot carry is dropped by name", () => {
    const drops: TranslationDrop[] = []
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [
                  { type: "tool_reference", tool_name: "mcp__db__query" },
                  { type: "text", text: "found one" },
                ],
              },
            ],
          },
        ],
      }),
      { onDrop: (drop) => void drops.push(drop) },
    )
    expect(out.messages[0]?.content).toBe("found one")
    expect(drops[0]?.field).toBe("messages[0].content[0].content[0]")
    expect(drops[0]?.reason).toContain("tool_reference")
  })
})

describe("consecutive turn merging (upstream compatibility, not a spec requirement)", () => {
  test("two consecutive plain user turns fold into one", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])
  })

  test("a turn carrying tool_calls is never merged into a neighbor", () => {
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "n", input: {} }],
          },
          { role: "assistant", content: "trailing text" },
        ],
      }),
    )
    expect(out.messages).toHaveLength(2)
  })
})

describe("tools and tool_choice", () => {
  test("passes tools through the shared converter", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest({ tools: [anthropicTool()] }))
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up the weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ])
  })

  test("tool_choice: any maps to required", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest({ tool_choice: { type: "any" } }))
    expect(out.tool_choice).toBe("required")
  })

  test("a server-side tool (no input_schema) is dropped and reported by name", () => {
    const drops: TranslationDrop[] = []
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({ tools: [{ type: "web_search_20250305", name: "web_search" }] }),
      { onDrop: (drop) => void drops.push(drop) },
    )
    // Nothing left to declare: omitted rather than sent as `tools: []`.
    expect(out.tools).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain("tools")
    expect(drops).toEqual([{ field: "tools[0]", reason: expect.stringContaining("web_search") }])
  })

  test("a tool_choice naming a dropped tool goes with it", () => {
    const drops: TranslationDrop[] = []
    const out = anthropicToOpenAiChatRequest(
      anthropicRequest({
        tools: [{ type: "web_search_20250305", name: "web_search" }, anthropicTool()],
        tool_choice: { type: "tool", name: "web_search" },
      }),
      { onDrop: (drop) => void drops.push(drop) },
    )
    expect(out.tool_choice).toBeUndefined()
    expect(drops.map((drop) => drop.field)).toEqual(["tools[0]", "tool_choice"])
  })
})

describe("malformed request bodies", () => {
  test("a missing max_tokens is a 400 naming the field", () => {
    const body = anthropicRequest() as Record<string, unknown>
    delete body.max_tokens
    expect(() => anthropicToOpenAiChatRequest(body)).toThrow(TranslationError)
  })

  test("an empty messages array is a 400", () => {
    expect(() => anthropicToOpenAiChatRequest(anthropicRequest({ messages: [] }))).toThrow(
      TranslationError,
    )
  })
})
