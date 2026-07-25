/**
 * Chat Completions → `POST /v1/messages`, fixture-driven
 * (docs/idea/06-protocol-translation.md#messages-array).
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import { DEFAULT_MAX_TOKENS, openAiChatToAnthropicRequest } from "../../../src/services/translate"
import { openAiChatRequest, openAiChatTool } from "./fixtures"

describe("max_tokens defaulting", () => {
  test("max_completion_tokens wins over max_tokens", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({ max_tokens: 100, max_completion_tokens: 200 }),
    )
    expect(out.max_tokens).toBe(200)
  })

  test("max_tokens is used when max_completion_tokens is absent", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ max_tokens: 100 }))
    expect(out.max_tokens).toBe(100)
  })

  test("an injected default is used when neither is present", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest(), { defaultMaxTokens: 777 })
    expect(out.max_tokens).toBe(777)
  })

  test("falls back to the module default when no option is given", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest())
    expect(out.max_tokens).toBe(DEFAULT_MAX_TOKENS)
  })
})

describe("system and developer roles", () => {
  test("system and developer turns both fold into the one anthropic system prompt", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        messages: [
          { role: "system", content: "be terse" },
          { role: "developer", content: "no markdown" },
          { role: "user", content: "hi" },
        ],
      }),
    )
    expect(out.system).toBe("be terse\n\nno markdown")
  })
})

describe("alternation: merge, never reorder", () => {
  test("consecutive user turns merge into one, in the order they arrived", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      }),
    )
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    })
  })

  test("consecutive tool results merge onto one user turn", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", function: { name: "a", arguments: "{}" } },
              { id: "call_2", function: { name: "b", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "one" },
          { role: "tool", tool_call_id: "call_2", content: "two" },
        ],
      }),
    )
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "one" },
        { type: "tool_result", tool_use_id: "call_2", content: "two" },
      ],
    })
  })
})

describe("images", () => {
  test("a data: URI image becomes a base64 source", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ])
  })

  test("an http(s) URL is carried as a url source, never fetched", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ])
  })

  test("a source that is neither data: nor http(s) is rejected", () => {
    expect(() =>
      openAiChatToAnthropicRequest(
        openAiChatRequest({
          messages: [
            { role: "user", content: [{ type: "image_url", image_url: { url: "ftp://x" } }] },
          ],
        }),
      ),
    ).toThrow(TranslationError)
  })
})

describe("tool_calls and tool results", () => {
  test("assistant tool_calls become tool_use blocks with parsed arguments", () => {
    const out = openAiChatToAnthropicRequest(
      openAiChatRequest({
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", function: { name: "get_weather", arguments: '{"city":"sf"}' } },
            ],
          },
        ],
      }),
    )
    expect(out.messages[0]?.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "sf" } },
    ])
  })

  test("a tool message whose tool_call_id matches no earlier call is rejected", () => {
    expect(() =>
      openAiChatToAnthropicRequest(
        openAiChatRequest({
          messages: [{ role: "tool", tool_call_id: "ghost", content: "x" }],
        }),
      ),
    ).toThrow(/tool_call_id/)
  })

  test("malformed tool_call arguments are a 400, not an empty call", () => {
    expect(() =>
      openAiChatToAnthropicRequest(
        openAiChatRequest({
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", function: { name: "n", arguments: "not json" } }],
            },
          ],
        }),
      ),
    ).toThrow(TranslationError)
  })
})

describe("rejected fields with no anthropic counterpart", () => {
  test("logprobs: true is refused by name", () => {
    expect(() => openAiChatToAnthropicRequest(openAiChatRequest({ logprobs: true }))).toThrow(
      /logprobs/,
    )
  })

  test("top_logprobs is refused by name", () => {
    expect(() => openAiChatToAnthropicRequest(openAiChatRequest({ top_logprobs: 5 }))).toThrow(
      /top_logprobs/,
    )
  })

  test("n > 1 is refused: one request cannot yield four completions", () => {
    expect(() => openAiChatToAnthropicRequest(openAiChatRequest({ n: 4 }))).toThrow(/n/)
  })

  test("n: 1 passes: it is the anthropic default already", () => {
    expect(() => openAiChatToAnthropicRequest(openAiChatRequest({ n: 1 }))).not.toThrow()
  })

  test("an audio or file content part is refused by name", () => {
    expect(() =>
      openAiChatToAnthropicRequest(
        openAiChatRequest({
          messages: [
            {
              role: "user",
              content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }],
            },
          ],
        }),
      ),
    ).toThrow(TranslationError)
  })
})

describe("stop sequences", () => {
  test("a single stop string becomes a one-element array", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ stop: "STOP" }))
    expect(out.stop_sequences).toEqual(["STOP"])
  })

  test("an array of stop strings is carried as-is", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ stop: ["A", "B"] }))
    expect(out.stop_sequences).toEqual(["A", "B"])
  })

  test("null/absent stop yields no stop_sequences field", () => {
    expect(
      openAiChatToAnthropicRequest(openAiChatRequest({ stop: null })).stop_sequences,
    ).toBeUndefined()
    expect(openAiChatToAnthropicRequest(openAiChatRequest()).stop_sequences).toBeUndefined()
  })
})

describe("tools and tool_choice", () => {
  test("passes tools through the shared converter", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ tools: [openAiChatTool()] }))
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "Look up the weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ])
  })

  test("tool_choice: required maps to any", () => {
    const out = openAiChatToAnthropicRequest(openAiChatRequest({ tool_choice: "required" }))
    expect(out.tool_choice).toEqual({ type: "any" })
  })
})

describe("empty and malformed bodies", () => {
  test("a transcript with no user or assistant turn is rejected", () => {
    expect(() =>
      openAiChatToAnthropicRequest(
        openAiChatRequest({ messages: [{ role: "system", content: "x" }] }),
      ),
    ).toThrow(TranslationError)
  })

  test("a body that is not a valid openai-chat request is a 400", () => {
    expect(() => openAiChatToAnthropicRequest({ model: "x" })).toThrow(TranslationError)
  })
})
