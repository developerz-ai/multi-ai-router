/**
 * The request a current Claude Code (2.1.x) sends to `POST /v1/messages`, translated toward the two
 * OpenAI dialects — every field a coding agent puts on the wire, at once.
 *
 * Production pinned this: 213 `translation_failed` 400s in one week from one key, all Claude Code
 * against an openai-chat pool. A cross-dialect hop drops what the target cannot represent and
 * reports the drop by name; a 400 is reserved for a body that is not a valid Anthropic request at
 * all (docs/idea/06-protocol-translation.md#known-lossy-edges).
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequest,
  type TranslationDrop,
} from "../../../src/services/translate"

const CACHE = { cache_control: { type: "ephemeral" } }

/** Verbatim shape, values shortened. Nothing here is exotic — it is one turn of an agent session. */
function claudeCodeRequest(): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 32_000,
    stream: true,
    temperature: 1,
    stop_sequences: [],
    metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "s" }) },
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "xhigh" },
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    container: null,
    mcp_servers: [],
    system: [
      { type: "text", text: "You are Claude Code.", ...CACHE },
      { type: "text", text: "# CLAUDE.md contents", ...CACHE },
    ],
    tools: [
      { type: "bash_20250124", name: "bash" },
      { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        name: "Read",
        description: "Reads a file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        strict: false,
        eager_input_streaming: true,
      },
      {
        name: "mcp__db__query",
        description: "Deferred MCP tool",
        input_schema: { type: "object", properties: { sql: { type: "string" } } },
        defer_loading: true,
      },
      {
        name: "Bash",
        description: "Runs a command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
        ...CACHE,
      },
    ],
    tool_choice: { type: "auto", disable_parallel_tool_use: false },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "read the screenshot and the spec, then search the web" },
          { type: "document", source: { type: "text", media_type: "text/plain", data: "SPEC" } },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me look", signature: "sig-abc" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "spec" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [{ type: "web_search_result", url: "https://example.test", title: "t" }],
          },
          { type: "text", text: "Searching done; reading the file." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "shot.png" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: false,
            content: [
              { type: "text", text: "(image)" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
            ...CACHE,
          },
        ],
      },
    ],
  }
}

function collect(): { drops: TranslationDrop[]; onDrop: (drop: TranslationDrop) => void } {
  const drops: TranslationDrop[] = []
  return { drops, onDrop: (drop) => void drops.push(drop) }
}

describe("a Claude Code 2.1.x turn toward openai-chat", () => {
  test("is served: nothing in it is a 400", () => {
    expect(() => anthropicToOpenAiChatRequest(claudeCodeRequest())).not.toThrow()
  })

  test("client tools survive, server-side and built-in ones are dropped by name", () => {
    const { drops, onDrop } = collect()
    const out = anthropicToOpenAiChatRequest(claudeCodeRequest(), { onDrop })

    expect(out.tools?.map((tool) => tool.function.name)).toEqual(["Read", "mcp__db__query", "Bash"])
    // `defer_loading`, `strict`, `eager_input_streaming`, `cache_control` never reach the wire.
    expect(JSON.stringify(out.tools)).not.toMatch(/defer_loading|strict|eager_input|cache_control/)
    const droppedTools = drops.filter((drop) => drop.field.startsWith("tools["))
    expect(droppedTools.map((drop) => drop.field)).toEqual([
      "tools[0]",
      "tools[1]",
      "tools[2]",
      "tools[3]",
    ])
    expect(droppedTools[2]?.reason).toContain("web_search_20260209")
    expect(out.tool_choice).toBe("auto")
  })

  test("a text document is carried as text; a PDF is dropped by name", () => {
    const { drops, onDrop } = collect()
    const out = anthropicToOpenAiChatRequest(claudeCodeRequest(), { onDrop })

    const first = out.messages[1]
    expect(first?.role).toBe("user")
    expect(JSON.stringify(first?.content)).toContain("SPEC")
    expect(JSON.stringify(first?.content)).not.toContain("JVBERi0=")
    expect(drops.some((drop) => drop.field === "messages[0].content[2]")).toBe(true)
    expect(drops.find((drop) => drop.field === "messages[0].content[2]")?.reason).toContain(
      "application/pdf",
    )
  })

  test("thinking, server_tool_use and web_search_tool_result leave the assistant turn; text and the call stay", () => {
    const { drops, onDrop } = collect()
    const out = anthropicToOpenAiChatRequest(claudeCodeRequest(), { onDrop })

    const assistant = out.messages.find((message) => message.role === "assistant")
    expect(assistant?.content).toBe("Searching done; reading the file.")
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("Read")
    expect(JSON.stringify(out)).not.toMatch(/sig-abc|opaque|srv_1|web_search_result/)
    // The provider's own artifacts are reported as dropped; the thinking blocks are a documented
    // hint and are not.
    expect(drops.map((drop) => drop.field)).toContain("messages[1].content[2]")
    expect(drops.map((drop) => drop.field)).toContain("messages[1].content[3]")
    expect(drops.map((drop) => drop.field)).not.toContain("messages[1].content[0]")
  })

  test("an image inside a tool_result is hoisted into the user turn that follows the tool message", () => {
    const out = anthropicToOpenAiChatRequest(claudeCodeRequest())

    const toolIndex = out.messages.findIndex((message) => message.role === "tool")
    expect(toolIndex).toBeGreaterThan(0)
    expect(out.messages[toolIndex]).toMatchObject({ tool_call_id: "toolu_1", content: "(image)" })
    expect(out.messages[toolIndex + 1]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      tool_calls: undefined,
      tool_call_id: undefined,
    })
  })

  test("the request-level knobs the target cannot carry are stripped, never forwarded", () => {
    const out = anthropicToOpenAiChatRequest(claudeCodeRequest()) as Record<string, unknown>

    for (const field of [
      "thinking",
      "output_config",
      "context_management",
      "metadata",
      "container",
      "mcp_servers",
      "stop_sequences",
    ]) {
      expect(out[field] === undefined || (Array.isArray(out[field]) && field === "stop")).toBe(true)
    }
    expect(out.stop).toEqual([])
    expect(out.stream).toBe(true)
    expect(out.max_tokens).toBe(32_000)
  })
})

describe("a Claude Code 2.1.x turn toward openai-responses", () => {
  test("is served, with the same drops reported", () => {
    const { drops, onDrop } = collect()
    const body = claudeCodeRequest()
    // The one field that stays a refusal on this target is a *stated* stop sequence; an empty
    // list states none.
    const out = anthropicToOpenAiResponsesRequest(body, { onDrop })

    expect(out.tools?.map((tool) => tool.name)).toEqual(["Read", "mcp__db__query", "Bash"])
    expect(drops.map((drop) => drop.field)).toEqual(
      expect.arrayContaining(["tools[0]", "tools[3]", "messages[0].content[2]"]),
    )
    const outputs = out.input.filter((item) => item.type === "function_call_output")
    expect(outputs).toHaveLength(1)
    const after = out.input[out.input.indexOf(outputs[0] as (typeof out.input)[number]) + 1]
    expect(after).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    })
  })
})

describe("what is still a 400", () => {
  test("a body with no messages at all is not an Anthropic request", () => {
    const body = claudeCodeRequest()
    delete body.messages
    expect(() => anthropicToOpenAiChatRequest(body)).toThrow(/messages/)
  })

  test("a tool_choice naming a tool that was dropped is dropped with it, not sent upstream", () => {
    const { drops, onDrop } = collect()
    const body = { ...claudeCodeRequest(), tool_choice: { type: "tool", name: "web_search" } }
    const out = anthropicToOpenAiChatRequest(body, { onDrop })

    expect(out.tool_choice).toBeUndefined()
    expect(drops.some((drop) => drop.field === "tool_choice")).toBe(true)
  })
})
