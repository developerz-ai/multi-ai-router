import { describe, expect, test } from "bun:test"
import {
  applyResponsesModelDials,
  openAiChatToOpenAiResponsesRequest,
} from "../../../src/services/translate"
import { openAiChatRequest } from "./fixtures"

/**
 * #489. Prod fingerprint (a client, 2026-11-18..22): a per-turn `system` note written mid-transcript
 * was joined into `instructions`, so cached tokens grew by exactly one note per turn (+512, +2,176)
 * and never reached the history — warm step 0 cached 43.3% against 94.2% for later steps.
 */
const turn2 = [
  { role: "system", content: "SYS" },
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "system", content: "NOTE-1" },
  { role: "user", content: "u2" },
]
const turn3 = [
  ...turn2,
  { role: "assistant", content: "a2" },
  { role: "developer", content: [{ type: "text", text: "NOTE-2" }] },
  { role: "user", content: "u3" },
]

function shape(input: readonly unknown[]): string[] {
  return input.map((item) => {
    const { role, content } = item as { role: string; content: { text: string }[] }
    return `${role}:${content[0]?.text}`
  })
}

describe("openai-chat -> openai-responses: mid-conversation system messages (#489)", () => {
  test("only the leading run is `instructions`; a later one stays in place as a developer item", () => {
    const out = openAiChatToOpenAiResponsesRequest(openAiChatRequest({ messages: turn2 }))
    expect(out.instructions).toBe("SYS")
    expect(shape(out.input)).toEqual(["user:u1", "assistant:a1", "developer:NOTE-1", "user:u2"])
    expect(out.input[2]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "NOTE-1" }],
    })
  })

  test("a turn's translation is a strict prefix of the next turn's, instructions included", () => {
    const second = openAiChatToOpenAiResponsesRequest(openAiChatRequest({ messages: turn2 }))
    const third = openAiChatToOpenAiResponsesRequest(openAiChatRequest({ messages: turn3 }))
    expect(third.instructions).toBe(second.instructions)
    expect(third.input.slice(0, second.input.length)).toEqual([...second.input])
    expect(shape(third.input).slice(second.input.length)).toEqual([
      "assistant:a2",
      "developer:NOTE-2",
      "user:u3",
    ])
  })

  test("several leading system messages still join; adjacent later ones are one item each", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({
        messages: [
          { role: "system", content: "A" },
          { role: "developer", content: "B" },
          { role: "user", content: "u1" },
          { role: "system", content: "N1" },
          { role: "system", content: "N2" },
        ],
      }),
    )
    expect(out.instructions).toBe("A\n\nB")
    expect(shape(out.input)).toEqual(["user:u1", "developer:N1", "developer:N2"])
  })

  test("with no leading system message there is no `instructions`, and an empty note is no item", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({
        messages: [
          { role: "user", content: "u1" },
          { role: "system", content: "" },
          { role: "system", content: "N1" },
        ],
      }),
    )
    expect(out.instructions).toBeUndefined()
    expect(shape(out.input)).toEqual(["user:u1", "developer:N1"])
  })

  test("a turn that translated to nothing still ends the leading run: position decides, not output", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({
        messages: [
          { role: "system", content: "A" },
          { role: "user", content: "" },
          { role: "system", content: "N1" },
          { role: "user", content: "u" },
        ],
      }),
    )
    expect(out.instructions).toBe("A")
    expect(shape(out.input)).toEqual(["developer:N1", "user:u"])
  })

  test("an image in a mid-conversation system message is still refused by name", () => {
    expect(() =>
      openAiChatToOpenAiResponsesRequest(
        openAiChatRequest({
          messages: [
            { role: "user", content: "u" },
            {
              role: "system",
              content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
            },
          ],
        }),
      ),
    ).toThrow("messages[1].content")
  })

  test("composes with #477: one shape on GPT-6.2+ (lead developer item + notes in place) and before it", () => {
    const body = openAiChatToOpenAiResponsesRequest(openAiChatRequest({ messages: turn3 }))
    const rules = {
      requireStream: true,
      requireInstructions: true,
      unsupportedFields: [],
      stripLookaroundPatterns: false,
    }
    const late = applyResponsesModelDials({ ...body }, "gpt-6.2-sol", rules)
    expect(late.instructions).toBe("")
    expect(shape(late.input as unknown[])).toEqual([
      "developer:SYS",
      "user:u1",
      "assistant:a1",
      "developer:NOTE-1",
      "user:u2",
      "assistant:a2",
      "developer:NOTE-2",
      "user:u3",
    ])
    const early = applyResponsesModelDials({ ...body }, "gpt-6.1-sol", rules)
    expect(early.instructions).toBe("SYS")
    expect(shape(early.input as unknown[])).toEqual(shape(late.input as unknown[]).slice(1))
  })
})
