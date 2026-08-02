import { describe, expect, test } from "bun:test"
import { buildSdkPrompt, type PromptBlock, type SdkRequestMessage } from "../../../src/providers"

/**
 * What one `query()` turn is actually asked (`prompt.ts`).
 *
 * The module is pure, so every case below is stated as data: a conversation and a lineage plan in,
 * the content of one user message out. Two properties carry the weight
 * (docs/idea/11-anthropic-agent-sdk.md §4):
 *
 * - **A resume sends the delta and only the delta.** Re-sending what the SDK session already holds
 *   is a duplicated turn at best and a self-play transcript at worst.
 * - **A replay is framed.** A flat transcript with no framing teaches the model to continue both
 *   speakers and to write tool calls as prose, which is the failure the frame exists to prevent.
 */

function user(content: SdkRequestMessage["content"]): SdkRequestMessage {
  return { role: "user", content }
}

function assistant(content: SdkRequestMessage["content"]): SdkRequestMessage {
  return { role: "assistant", content }
}

function textOf(blocks: readonly PromptBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

const FRESH = { kind: "fresh", reason: "no-session" } as const

describe("a single user turn", () => {
  test("is sent as itself, with no framing at all", () => {
    const blocks = buildSdkPrompt({ messages: [user("what is 2 + 2?")], plan: FRESH })
    expect(blocks).toEqual([{ type: "text", text: "what is 2 + 2?" }])
  })

  test("keeps its own content blocks rather than being re-flattened", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([
          { type: "text", text: "look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          { type: "text", text: "and tell me" },
        ]),
      ],
      plan: FRESH,
    })

    expect(blocks).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: "and tell me" },
    ])
  })

  test("adjacent text blocks are joined, so fifteen blocks do not become fifteen", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ]),
      ],
      plan: FRESH,
    })
    expect(blocks).toEqual([{ type: "text", text: "one\ntwo" }])
  })

  test("a url image source is forwarded, and a source shape the SDK would reject is not", () => {
    const forwarded = buildSdkPrompt({
      messages: [user([{ type: "image", source: { type: "url", url: "https://x/y.png" } }])],
      plan: FRESH,
    })
    expect(forwarded).toEqual([{ type: "image", source: { type: "url", url: "https://x/y.png" } }])

    const described = buildSdkPrompt({
      messages: [user([{ type: "image", source: { type: "base64", media_type: "image/tiff" } }])],
      plan: FRESH,
    })
    expect(described.every((block) => block.type === "text")).toBe(true)
    expect(textOf(described)).toContain("image")
  })

  test("an omitted image says why, so the model can tell the user what is missing", () => {
    const badMedia = buildSdkPrompt({
      messages: [
        user([{ type: "image", source: { type: "base64", media_type: "image/tiff", data: "A" } }]),
      ],
      plan: FRESH,
    })
    expect(textOf(badMedia)).toBe("[image omitted: unsupported source type image/tiff]")

    const badShape = buildSdkPrompt({
      messages: [user([{ type: "image", source: { type: "file", file_id: "f_1" } }])],
      plan: FRESH,
    })
    expect(textOf(badShape)).toBe("[image omitted: unsupported source type file]")
  })

  test("the image/jpg misspelling is normalized to image/jpeg rather than demoted to text", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([{ type: "image", source: { type: "base64", media_type: "image/jpg", data: "AAA" } }]),
      ],
      plan: FRESH,
    })
    expect(blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
    ])
  })
})

describe("a conversation the SDK has never held", () => {
  const conversation = [
    user("who wrote Dune?"),
    assistant("Frank Herbert."),
    user("and the sequel?"),
  ]

  test("is framed as a transcript, with the final user turn outside the frame", () => {
    const blocks = buildSdkPrompt({ messages: conversation, plan: FRESH })
    const text = textOf(blocks)

    expect(text).toContain("<prior_conversation>")
    expect(text).toContain("</prior_conversation>")
    expect(text).toContain("[user]")
    expect(text).toContain("[assistant]")
    expect(text).toContain("Frank Herbert.")
    // The question being asked is the last thing the model reads, after the frame closed.
    expect(blocks.at(-1)).toEqual({ type: "text", text: "and the sequel?" })
  })

  test("the framing says the transcript is context, not a pattern to continue", () => {
    const text = textOf(buildSdkPrompt({ messages: conversation, plan: FRESH }))
    expect(text).toContain("do not continue either speaker's turns")
    expect(text).toContain("do not invent tool calls")
  })

  test("an image in an earlier turn stays an image inside the frame", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([{ type: "image", source: { type: "url", url: "https://x/y.png" } }]),
        assistant("a cat"),
        user("what breed?"),
      ],
      plan: FRESH,
    })

    expect(blocks).toContainEqual({
      type: "image",
      source: { type: "url", url: "https://x/y.png" },
    })
  })

  test("a turn ending in an assistant prefill puts the prefill inside the frame", () => {
    const blocks = buildSdkPrompt({
      messages: [user("finish this: the capital of France is"), assistant("Par")],
      plan: FRESH,
    })
    const text = textOf(blocks)

    expect(text).toContain("<prior_conversation>")
    expect(text).toContain("Par")
    expect(blocks.at(-1)).toEqual({ type: "text", text: "</prior_conversation>" })
  })
})

describe("blocks with no user-message equivalent", () => {
  test("a tool_result is rendered as what happened, never replayed as a tool block", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([{ type: "tool_result", tool_use_id: "toolu_1", content: "72°F and clear" }]),
      ],
      plan: FRESH,
    })

    expect(blocks).toEqual([
      { type: "text", text: "[the client ran the requested tool and it returned: 72°F and clear]" },
    ])
  })

  test("a tool_result's nested images survive as sibling image blocks, never inside the line", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "S" } }
    const blocks = buildSdkPrompt({
      messages: [
        user([
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "screenshot taken" }, image],
          },
        ]),
      ],
      plan: FRESH,
    })

    // Both halves survive: the transcript line names the image, and the image itself follows as a
    // real block — a screenshot/chart/PDF-page tool used to lose it every turn.
    expect(blocks).toEqual([
      {
        type: "text",
        text: "[the client ran the requested tool and it returned: screenshot taken\n(and 1 image, forwarded below this line)]",
      },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "S" } },
    ])
  })

  test("an image-only tool_result forwards the image and the line says that is all there was", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "S" } },
            ],
          },
        ]),
      ],
      plan: FRESH,
    })

    expect(blocks).toEqual([
      {
        type: "text",
        text: "[the client ran the requested tool and it returned: 1 image, forwarded below this line]",
      },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "S" } },
    ])
  })

  test("a tool_result with neither text nor images still reads as no textual output", () => {
    const blocks = buildSdkPrompt({
      messages: [user([{ type: "tool_result", tool_use_id: "toolu_1", content: [] }])],
      plan: FRESH,
    })
    expect(textOf(blocks)).toContain("no textual output")
  })

  test("a failed tool result says so", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user([{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }]),
      ],
      plan: FRESH,
    })
    expect(textOf(blocks)).toContain("(it failed)")
  })

  test("an assistant tool_use is described, arguments and all", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user("weather?"),
        assistant([{ type: "tool_use", id: "t", name: "get_weather", input: { city: "Berlin" } }]),
        user("thanks"),
      ],
      plan: FRESH,
    })
    expect(textOf(blocks)).toContain('called get_weather with {"city":"Berlin"}')
  })

  test("thinking is dropped rather than replayed as text", () => {
    const blocks = buildSdkPrompt({
      messages: [
        user("hi"),
        assistant([
          { type: "thinking", thinking: "the user said hi", signature: "sig" },
          { type: "text", text: "hello" },
        ]),
        user("bye"),
      ],
      plan: FRESH,
    })
    const text = textOf(blocks)

    expect(text).not.toContain("the user said hi")
    expect(text).toContain("hello")
  })

  test("a block type this build has never seen is named, not silently lost", () => {
    const blocks = buildSdkPrompt({
      messages: [user([{ type: "hologram", data: "…" }])],
      plan: FRESH,
    })
    expect(textOf(blocks)).toBe("[hologram block]")
  })
})

describe("a turn that rejoins an SDK session", () => {
  const conversation = [
    user("who wrote Dune?"),
    assistant("Frank Herbert."),
    user("and the sequel?"),
  ]

  test("resume sends only what the session has not seen", () => {
    const blocks = buildSdkPrompt({
      messages: conversation,
      plan: { kind: "resume", sdkSessionId: "sess_1", lineage: "continuation", deltaFrom: 2 },
    })

    expect(blocks).toEqual([{ type: "text", text: "and the sequel?" }])
  })

  test("a fork sends its delta too — the rewind point is the launch's business, not the prompt's", () => {
    const blocks = buildSdkPrompt({
      messages: conversation,
      plan: { kind: "fork", sdkSessionId: "sess_1", resumeSessionAt: "uuid-1", deltaFrom: 2 },
    })

    expect(blocks).toEqual([{ type: "text", text: "and the sequel?" }])
  })

  test("a delta that computes to nothing still sends the last message, never an empty prompt", () => {
    const blocks = buildSdkPrompt({
      messages: conversation,
      plan: { kind: "resume", sdkSessionId: "sess_1", lineage: "compaction", deltaFrom: 3 },
    })

    expect(blocks).toEqual([{ type: "text", text: "and the sequel?" }])
  })

  test("a multi-message delta is framed exactly as a replay is", () => {
    const blocks = buildSdkPrompt({
      messages: conversation,
      plan: { kind: "resume", sdkSessionId: "sess_1", lineage: "continuation", deltaFrom: 1 },
    })
    const text = textOf(blocks)

    expect(text).toContain("<prior_conversation>")
    expect(text).not.toContain("who wrote Dune?")
    expect(blocks.at(-1)).toEqual({ type: "text", text: "and the sequel?" })
  })

  test("a delta index past the end of the conversation cannot slice out of bounds", () => {
    const blocks = buildSdkPrompt({
      messages: conversation,
      plan: { kind: "resume", sdkSessionId: "sess_1", lineage: "continuation", deltaFrom: 99 },
    })
    expect(blocks).toEqual([{ type: "text", text: "and the sequel?" }])
  })
})

describe("a conversation with nothing in it", () => {
  test("still produces a prompt, because an empty one is answered by nothing", () => {
    expect(buildSdkPrompt({ messages: [], plan: FRESH })).toEqual([{ type: "text", text: "" }])
  })
})
