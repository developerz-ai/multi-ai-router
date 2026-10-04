import { describe, expect, test } from "bun:test"
import { buildSdkPrompt, type PromptBlock } from "../../../src/providers/claude-sdk/prompt"
import { readSdkRequest, type SdkRequestMessage } from "../../../src/providers/claude-sdk/request"
import { hashMessages, readConversation } from "../../../src/providers/claude-sdk/session"

/**
 * Mid-conversation `role: "system"` messages (Anthropic SDK 0.131 `MessageParam.role`).
 *
 * Clients send them as per-turn instructions after a tool result, and — in beta — to add or
 * withdraw tools. The API accepts them, so an API-key Account (byte passthrough) served the turn
 * while a subscription Account refused it as a 400. These pin the subscription side: accepted,
 * attached to the turn they sit beside, hidden once `clear_at` says so, and kept apart from user
 * messages in the session lineage.
 */

const FRESH = { kind: "fresh", reason: "no-session" } as const

function body(messages: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ model: "m", messages }))
}

function textOf(blocks: readonly PromptBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

const user = (content: SdkRequestMessage["content"]): SdkRequestMessage => ({
  role: "user",
  content,
})
const assistant = (content: SdkRequestMessage["content"]): SdkRequestMessage => ({
  role: "assistant",
  content,
})
const system = (content: SdkRequestMessage["content"], cleared?: true): SdkRequestMessage =>
  cleared ? { role: "system", content, cleared } : { role: "system", content }

describe("reading a system message out of the body", () => {
  test("is accepted, not refused as an unknown role", () => {
    const request = readSdkRequest(
      body([
        { role: "user", content: "run the tests" },
        { role: "system", content: "be brief" },
      ]),
    )
    expect(request.messages.map((message) => message.role)).toEqual(["user", "system"])
  })

  test('clear_at "next_user_message" hides it only once a later user message exists', () => {
    const request = readSdkRequest(
      body([
        { role: "system", content: "first turn only", clear_at: "next_user_message" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "system", content: "still current", clear_at: "next_user_message" },
        { role: "system", content: "always", clear_at: "never" },
      ]),
    )
    expect(request.messages.map((message) => message.cleared === true)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  })
})

describe("rendering a system message into the prompt", () => {
  test("a reminder after the live user turn stays in that turn, unframed", () => {
    const blocks = buildSdkPrompt({
      messages: [user("fix the bug"), system("answer in one line")],
      plan: FRESH,
    })
    expect(textOf(blocks)).toBe("fix the bug\n[system]\nanswer in one line")
    expect(textOf(blocks)).not.toContain("<prior_conversation>")
  })

  test("an instruction before the opening message does not turn a first turn into a replay", () => {
    const blocks = buildSdkPrompt({ messages: [system("you are terse"), user("hi")], plan: FRESH })
    expect(textOf(blocks)).toBe("[system]\nyou are terse\nhi")
  })

  test("in history it is framed and labelled as system, the live turn outside the frame", () => {
    const text = textOf(
      buildSdkPrompt({
        messages: [user("a"), assistant("b"), system("now use tabs"), user("c")],
        plan: FRESH,
      }),
    )
    expect(text).toContain("[system]\nnow use tabs\n</prior_conversation>")
    expect(text.endsWith("</prior_conversation>\nc")).toBe(true)
  })

  test("a cleared message is not shown to the model", () => {
    const text = textOf(
      buildSdkPrompt({ messages: [system("stale", true), user("hi")], plan: FRESH }),
    )
    expect(text).toBe("hi")
  })

  test("a resume delta of a tool result plus a reminder sends both, unframed", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user("run it"),
        assistant([{ type: "tool_use", id: "t1", name: "bash", input: {} }]),
        user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
        system("summarize"),
      ],
      plan: { kind: "resume", sdkSessionId: "s", lineage: "continuation", deltaFrom: 2 },
    })
    const text = textOf(blocks)
    expect(text).not.toContain("<prior_conversation>")
    expect(text).toContain("returned: ok")
    expect(text.endsWith("[system]\nsummarize")).toBe(true)
  })

  test("tool_addition and tool_removal blocks are named, not shown as unknown blocks", () => {
    const text = textOf(
      buildSdkPrompt({
        messages: [
          user("hi"),
          system([
            { type: "tool_addition", tool: { type: "tool_reference", name: "grep" } },
            {
              type: "tool_addition",
              tool: { type: "tool_definition", definition: { name: "fmt", input_schema: {} } },
            },
            { type: "tool_removal", tool: { type: "tool_reference", name: "bash" } },
          ]),
        ],
        plan: FRESH,
      }),
    )
    expect(text).toContain("[the client added the tool grep]")
    expect(text).toContain("[the client added the tool fmt]")
    expect(text).toContain("[the client withdrew the tool bash]")
    expect(text).not.toContain("block]")
  })
})

describe("system messages in the session lineage", () => {
  const view = (messages: readonly unknown[]) => {
    const conversation = readConversation(body(messages))
    if (conversation === null) throw new Error("fixture did not parse")
    return conversation
  }

  test("a system message never seeds the fingerprint", () => {
    expect(
      view([
        { role: "system", content: "stock reminder" },
        { role: "user", content: "the real opening" },
      ]).firstUserText,
    ).toBe("the real opening")
  })

  test("hashes apart from a user message with the same text", () => {
    const [asSystem] = hashMessages(view([{ role: "system", content: "x" }]).messages)
    const [asUser] = hashMessages(view([{ role: "user", content: "x" }]).messages)
    expect(asSystem).not.toBe(asUser)
  })

  test("a trailing reminder does not hide that the turn is a tool result", () => {
    expect(
      view([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        { role: "system", content: "keep going" },
      ]).endsWithToolResult,
    ).toBe(true)
  })
})
