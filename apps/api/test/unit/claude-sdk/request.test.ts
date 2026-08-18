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

describe("tool_choice, the one Anthropic field this layer used to drop on the floor", () => {
  test('absent is null, read the same as "auto" downstream', () => {
    expect(readSdkRequest(body({ messages: [] })).toolChoice).toBeNull()
  })

  test("each shape the translator can emit round-trips verbatim", () => {
    expect(readSdkRequest(body({ tool_choice: { type: "auto" } })).toolChoice).toEqual({
      type: "auto",
    })
    expect(readSdkRequest(body({ tool_choice: { type: "any" } })).toolChoice).toEqual({
      type: "any",
    })
    expect(readSdkRequest(body({ tool_choice: { type: "none" } })).toolChoice).toEqual({
      type: "none",
    })
    expect(
      readSdkRequest(body({ tool_choice: { type: "tool", name: "get_weather" } })).toolChoice,
    ).toEqual({ type: "tool", name: "get_weather" })
  })

  // The two tests below assert the whole request SURVIVES, not just that `toolChoice` is null: an
  // earlier draft failed the object parse on a bad `tool_choice`, which read as null here too —
  // because the entire request had been wiped to `EMPTY`. The conversation must outlive one field.
  test("an unrecognized shape is absence of the field, not a failed turn", () => {
    const request = readSdkRequest(
      body({
        messages: [{ role: "user", content: "ping" }],
        system: "be terse",
        tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
        tool_choice: { type: "bogus" },
      }),
    )

    expect(request.toolChoice).toBeNull()
    expect(request.messages).toEqual([{ role: "user", content: "ping" }])
    expect(request.system).toBe("be terse")
    expect(request.tools.map((tool) => tool.name)).toEqual(["get_weather"])
  })

  test("an explicit null is absence of the field, not a failed turn", () => {
    const request = readSdkRequest(
      body({
        messages: [{ role: "user", content: "ping" }],
        system: "be terse",
        tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
        tool_choice: null,
      }),
    )

    expect(request.toolChoice).toBeNull()
    expect(request.messages).toEqual([{ role: "user", content: "ping" }])
    expect(request.system).toBe("be terse")
    expect(request.tools.map((tool) => tool.name)).toEqual(["get_weather"])
  })

  // A near miss is not a foreign shape: the `type` is one this vocabulary recognizes, so the client
  // *tried* to force a call and misspelt the payload — and degrading that to "auto" was the silent
  // downgrade this issue exists to kill, invisible because nothing visibly changes. Anthropic's own
  // API answers these shapes 400.
  test('a recognized "type" with an unreadable payload throws, rather than silently running optional', () => {
    for (const toolChoice of [
      { type: "tool" },
      { type: "tool", name: 7 },
      { type: "tool", name: null },
    ]) {
      expect(() =>
        readSdkRequest(
          body({ messages: [{ role: "user", content: "ping" }], tool_choice: toolChoice }),
        ),
      ).toThrow(
        'tool_choice\'s type "tool" is recognized but its payload is one this router cannot read',
      )
    }
  })
})

describe("a body that cannot be read", () => {
  test("null, empty, unparseable, and non-object bodies all read as an empty request", () => {
    const empty = { messages: [], system: null, tools: [], stream: false, toolChoice: null }

    expect(readSdkRequest(null)).toEqual(empty)
    expect(readSdkRequest(new Uint8Array())).toEqual(empty)
    expect(readSdkRequest(new TextEncoder().encode("{not json"))).toEqual(empty)
    expect(readSdkRequest(body("a string"))).toEqual(empty)
  })

  test("a body with no messages is empty rather than a refusal", () => {
    expect(readSdkRequest(body({ model: "claude-opus-5" })).messages).toEqual([])
  })
})
