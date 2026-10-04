import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequest,
} from "../../../src/services/translate"

/**
 * Anthropic's `system` is also a mid-conversation role (per-turn instructions, and beta
 * `tool_addition` / `tool_removal` blocks). The Agent-SDK path accepts it; the cross-dialect path
 * must too, or the same body succeeds on one account and 400s on the next. It becomes a mid-list
 * `system` message toward openai-chat (`developer` is refused by several compatible vendors) and a
 * `developer` input item toward openai-responses, in place; one with `clear_at: "next_user_message"` that a later user turn followed is gone.
 */
const body = {
  model: "m",
  max_tokens: 64,
  messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "system", content: "spent hint", clear_at: "next_user_message" },
    { role: "user", content: "second" },
    {
      role: "system",
      content: [
        { type: "text", text: "use the new tool" },
        { type: "tool_addition", tool: { name: "grep" } },
        { type: "tool_removal", tool: { definition: { name: "sed" } } },
      ],
    },
    { role: "system", content: "live hint", clear_at: "next_user_message" },
  ],
}

const DEVELOPER_TEXT =
  "use the new tool\n\n[the client added the tool grep]\n\n[the client withdrew the tool sed]"

describe("mid-conversation system turns", () => {
  test("openai-chat: system messages in place; a cleared one is dropped", () => {
    const out = anthropicToOpenAiChatRequest(body)
    // Adjacent same-role turns fold into one, as they do for every role on this target.
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"])
    expect(JSON.stringify(out.messages)).not.toContain("spent hint")
    expect(out.messages[3]?.content).toEqual([
      { type: "text", text: DEVELOPER_TEXT },
      { type: "text", text: "live hint" },
    ])
  })

  test("a cleared turn with no later user turn is still shown", () => {
    const out = anthropicToOpenAiChatRequest({
      ...body,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "pending hint", clear_at: "next_user_message" },
      ],
    })
    expect(out.messages.map((m) => m.role)).toEqual(["user", "system"])
    expect(out.messages[1]?.content).toBe("pending hint")
  })

  test("openai-responses: developer input items in place; a cleared one is dropped", () => {
    const out = anthropicToOpenAiResponsesRequest(body)
    const messages = out.input.filter((item) => item.type === "message")
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "developer",
      "developer",
    ])
    expect(JSON.stringify(out.input)).not.toContain("spent hint")
    const developer = messages[3]
    expect(developer?.content).toEqual([{ type: "input_text", text: DEVELOPER_TEXT }])
  })

  test("a top-level system prompt is unaffected", () => {
    const out = anthropicToOpenAiChatRequest({ ...body, system: "top" })
    expect(out.messages[0]).toMatchObject({ role: "system", content: "top" })
    expect(out.messages.map((m) => m.role)).not.toContain("developer")
    expect(anthropicToOpenAiResponsesRequest({ ...body, system: "top" }).instructions).toBe("top")
  })

  test("a system turn whose only blocks render to nothing adds no message", () => {
    const out = anthropicToOpenAiChatRequest({
      ...body,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "image", source: { type: "url", url: "x" } }] },
      ],
    })
    expect(out.messages.map((m) => m.role)).toEqual(["user"])
  })
})
