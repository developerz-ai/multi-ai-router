import { describe, expect, test } from "bun:test"
import {
  openAiChatToAnthropicRequest,
  openAiResponsesToAnthropicRequest,
} from "../../../src/services/translate"

/**
 * 2026-11-03: an OpenAI-wire client routed to an Anthropic upstream got **no** prompt caching at
 * all. Anthropic caches only at a `cache_control` breakpoint; the chat parser stripped the markers
 * an OpenRouter-style client writes on its parts, and a client that writes none (every plain OpenAI
 * client) reached Anthropic with no breakpoint anywhere. Toward Anthropic's own surface a request
 * with no marker now carries the top-level automatic marker; a client's own markers are kept where
 * it put them, and then no automatic one is added (both count toward Anthropic's cap of four).
 */

const MARK = { type: "ephemeral" } as const

function plainChat(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "you are a coding agent" },
      { role: "user", content: "fix the bug" },
    ],
  }
}

function markedChat(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: [{ type: "text", text: "stable rules", cache_control: MARK }] },
      { role: "system", content: "volatile tail" },
      { role: "user", content: [{ type: "text", text: "fix the bug", cache_control: MARK }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: [
          { type: "text", text: "file body", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  }
}

describe("openai-chat → anthropic: the client's own markers", () => {
  const out = openAiChatToAnthropicRequest(markedChat(), { automaticCache: true })

  test("a marked system message keeps its own block, its marker where the client put it", () => {
    expect(out.system).toEqual([
      { type: "text", text: "stable rules", cache_control: MARK },
      { type: "text", text: "volatile tail" },
    ])
  })

  test("a marked user part keeps its marker", () => {
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "fix the bug", cache_control: MARK },
    ])
  })

  test("a marked tool message puts the marker on its tool_result", () => {
    expect(out.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "c1",
        content: "file body",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ])
  })

  test("with the client's markers present, no automatic marker is added", () => {
    expect(out.cache_control).toBeUndefined()
  })

  test("a client's top-level marker is carried as Anthropic's automatic one", () => {
    const body = { ...plainChat(), cache_control: { type: "ephemeral", ttl: "1h" } }
    expect(openAiChatToAnthropicRequest(body, { automaticCache: true }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
  })

  test("block markers reach every anthropic surface; the top-level one only a surface that takes it", () => {
    const out = openAiChatToAnthropicRequest({ ...markedChat(), cache_control: MARK })
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "fix the bug", cache_control: MARK },
    ])
    expect(out.cache_control).toBeUndefined()
  })
})

describe("openai-chat → anthropic: the automatic marker", () => {
  test("toward a surface that takes it, an unmarked request gets the top-level marker", () => {
    const out = openAiChatToAnthropicRequest(plainChat(), { automaticCache: true })
    expect(out.cache_control).toEqual(MARK)
    // The shapes an unmarked request always had are unchanged.
    expect(out.system).toBe("you are a coding agent")
  })

  test("toward any other anthropic surface, none is invented", () => {
    const out = openAiChatToAnthropicRequest(plainChat())
    expect(JSON.stringify(out)).not.toContain("cache_control")
  })
})

describe("openai-responses → anthropic: the automatic marker", () => {
  const body = { model: "claude-sonnet-4-5", instructions: "be terse", input: "fix the bug" }

  test("toward a surface that takes it, the request gets the top-level marker", () => {
    expect(openAiResponsesToAnthropicRequest(body, { automaticCache: true }).cache_control).toEqual(
      MARK,
    )
  })

  test("toward any other anthropic surface, none is invented", () => {
    expect(JSON.stringify(openAiResponsesToAnthropicRequest(body))).not.toContain("cache_control")
  })
})
