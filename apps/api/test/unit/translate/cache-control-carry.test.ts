import { describe, expect, test } from "bun:test"
import { anthropicToOpenAiChatRequest } from "../../../src/services/translate"

/**
 * 2026-11-03: an Anthropic-wire client (Claude Code) routed to an `openrouter` account reached
 * `anthropic/*` with **zero** cache breakpoints — the translator stripped every `cache_control`,
 * on the stated premise that no non-Anthropic target has an equivalent hint. OpenRouter's
 * OpenAI-compatible API takes `cache_control` on content parts (and at the top level) and maps it
 * to each provider's own marker (openrouter.ai/docs/features/prompt-caching, read 2026-11-03), so a
 * cached Claude prefix was re-billed as cold prefill on every turn. A surface that does not state
 * it carries the marker keeps the old strip: a strict upstream `400`s on a field it does not know.
 */

const CACHE = { cache_control: { type: "ephemeral" } } as const

function claudeCodeTurn(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    cache_control: { type: "ephemeral" },
    system: [
      { type: "text", text: "You are Claude Code.", ...CACHE },
      { type: "text", text: "# CLAUDE.md contents", ...CACHE },
      { type: "text", text: "dynamic tail" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "fix the bug", ...CACHE }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file body", ...CACHE }],
      },
    ],
  }
}

describe("anthropic → openai-chat: cache_control toward a surface that carries it", () => {
  const out = anthropicToOpenAiChatRequest(claudeCodeTurn(), { cacheControl: true })

  test("each system block stays its own part, its breakpoint where the client put it", () => {
    expect(out.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "You are Claude Code.", ...CACHE },
        { type: "text", text: "# CLAUDE.md contents", ...CACHE },
        { type: "text", text: "dynamic tail" },
      ],
    })
  })

  test("a marked user text block keeps its marker, and is not collapsed to a string", () => {
    expect(out.messages[1]?.content).toEqual([{ type: "text", text: "fix the bug", ...CACHE }])
  })

  test("a marked tool_result carries the rolling breakpoint on its tool message", () => {
    const tool = out.messages.find((message) => message.role === "tool")
    expect(tool?.content).toEqual([{ type: "text", text: "file body", ...CACHE }])
  })

  test("a top-level (automatic) cache_control is carried at the top level", () => {
    expect(out.cache_control).toEqual({ type: "ephemeral" })
  })

  test("a ttl is carried; an unrecognized marker is dropped rather than refused", () => {
    const body = claudeCodeTurn()
    body.messages = [
      {
        role: "user",
        content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "b", cache_control: { type: "persistent" } }],
      },
    ]
    const result = anthropicToOpenAiChatRequest(body, { cacheControl: true })
    expect(result.messages[1]?.content).toEqual([
      { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "b" },
    ])
  })
})

describe("anthropic → openai-chat: a surface that does not carry it still gets none", () => {
  test("no cache_control anywhere, and the shapes stay the collapsed strings they were", () => {
    const out = anthropicToOpenAiChatRequest(claudeCodeTurn())
    expect(JSON.stringify(out)).not.toContain("cache_control")
    expect(out.messages[0]?.content).toBe(
      "You are Claude Code.\n\n# CLAUDE.md contents\n\ndynamic tail",
    )
    expect(out.messages[1]?.content).toBe("fix the bug")
  })
})
