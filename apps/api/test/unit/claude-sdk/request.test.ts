import { describe, expect, test } from "bun:test"
import { readSdkRequest } from "../../../src/providers"

/**
 * The one parse of the body the Agent-SDK path performs (`request.ts`).
 *
 * Everything downstream — the prompt, the tool registration, the system prompt, the response shape
 * — reads this and nothing else, so a field this module drops is a field the SDK never hears about.
 * The properties asserted below are therefore all "absence stays absence": an unreadable body is
 * empty rather than an error, and a missing field is missing rather than defaulted into a claim the
 * client never made (docs/idea/11-anthropic-agent-sdk.md §6).
 */

function body(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

describe("what a launch reads out of an Anthropic Messages body", () => {
  test("messages keep their role and their content verbatim", () => {
    const request = readSdkRequest(
      body({
        model: "claude-opus-5",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    )

    expect(request.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])
  })

  test("a role this build does not know is read as the user's, never the assistant's", () => {
    const request = readSdkRequest(body({ messages: [{ role: "system", content: "x" }] }))
    expect(request.messages[0]?.role).toBe("user")
  })

  test("stream is only true when the client said so", () => {
    expect(readSdkRequest(body({ messages: [], stream: true })).stream).toBe(true)
    expect(readSdkRequest(body({ messages: [], stream: false })).stream).toBe(false)
    expect(readSdkRequest(body({ messages: [] })).stream).toBe(false)
  })

  test("a system string passes through, and an empty one is absence", () => {
    expect(readSdkRequest(body({ system: "be terse" })).system).toBe("be terse")
    expect(readSdkRequest(body({ system: "" })).system).toBeNull()
    expect(readSdkRequest(body({ messages: [] })).system).toBeNull()
  })

  test("system blocks flatten to the SDK's string list, dropping what has no text", () => {
    const request = readSdkRequest(
      body({
        system: [
          { type: "text", text: "one" },
          { type: "image", source: { type: "url", url: "https://x/y.png" } },
          { type: "text", text: "two" },
        ],
      }),
    )
    expect(request.system).toEqual(["one", "two"])
  })

  test("a system list with no text at all is absence, not an empty prompt", () => {
    const request = readSdkRequest(body({ system: [{ type: "text", text: "" }] }))
    expect(request.system).toBeNull()
  })

  test("the client's tools come out in one read, ready for registration", () => {
    const request = readSdkRequest(
      body({
        messages: [],
        tools: [
          { name: "get_weather", description: "d", input_schema: { type: "object" } },
          { name: "search" },
        ],
      }),
    )
    expect(request.tools.map((tool) => tool.name)).toEqual(["get_weather", "search"])
  })

  test("a tools field that is not a list of tools is no tools, not a failed turn", () => {
    expect(readSdkRequest(body({ tools: "everything" })).tools).toEqual([])
    expect(readSdkRequest(body({ tools: [{ description: "no name" }] })).tools).toEqual([])
  })
})

describe("a body that cannot be read", () => {
  test("null, empty, unparseable, and non-object bodies all read as an empty request", () => {
    const empty = { messages: [], system: null, tools: [], stream: false }

    expect(readSdkRequest(null)).toEqual(empty)
    expect(readSdkRequest(new Uint8Array())).toEqual(empty)
    expect(readSdkRequest(new TextEncoder().encode("{not json"))).toEqual(empty)
    expect(readSdkRequest(body("a string"))).toEqual(empty)
  })

  test("a body with no messages is empty rather than a refusal", () => {
    expect(readSdkRequest(body({ model: "claude-opus-5" })).messages).toEqual([])
  })
})
