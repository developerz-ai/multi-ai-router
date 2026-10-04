import { expect, test } from "bun:test"
import { openAiResponsesToAnthropicResponse as anthropicResponse } from "../../../src/services/translate/openai-responses-to-anthropic/response"
import { openAiResponsesToAnthropicStream as anthropic } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatResponse as chatResponse } from "../../../src/services/translate/openai-responses-to-openai-chat/response"
import { openAiResponsesToOpenAiChatStream as chat } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"

const body = {
  id: "fixture",
  model: "fixture",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg",
      role: "assistant",
      content: [
        { type: "output_text", text: "Answer" },
        { type: "refusal", refusal: "Cannot comply" },
      ],
    },
  ],
}
const frames = [
  {
    type: "response.output_text.delta",
    delta: "Answer",
    item_id: "msg",
    output_index: 0,
    content_index: 0,
  },
  {
    type: "response.refusal.delta",
    delta: "Cannot ",
    item_id: "msg",
    output_index: 0,
    content_index: 1,
  },
  {
    type: "response.refusal.delta",
    delta: "comply",
    item_id: "msg",
    output_index: 0,
    content_index: 1,
  },
  {
    type: "response.refusal.done",
    refusal: "Cannot comply",
    item_id: "msg",
    output_index: 0,
    content_index: 1,
  },
]
test("mixed text and refusal preserves nonstream Chat text", () => {
  const t = chat({ created: 0 })
  const events = frames.flatMap((frame) =>
    t.push({ event: frame.type, data: JSON.stringify(frame) }),
  )
  const actual = events.map((e) => JSON.parse(e.data).choices?.[0]?.delta?.content ?? "").join("")
  const expected = (
    chatResponse(body, { created: 0 }).body as { choices: { message: { content: string } }[] }
  ).choices[0]?.message.content
  if (expected === undefined) throw new Error("Missing fixture completion text")
  expect(actual).toBe(expected)
})
test("mixed text and refusal preserves nonstream Anthropic text", () => {
  const t = anthropic()
  const events = frames.flatMap((frame) =>
    t.push({ event: frame.type, data: JSON.stringify(frame) }),
  )
  const actual = events.map((e) => JSON.parse(e.data).delta?.text ?? "").join("")
  const expected = (anthropicResponse(body).body as { content: { text: string }[] }).content
    .map((c) => c.text)
    .join("")
  expect(actual).toBe(expected)
})

for (const dialect of ["chat", "anthropic"] as const) {
  test(`${dialect}: refusal only and multiple message items preserve parts without duplicate done mirrors`, () => {
    const translator = dialect === "chat" ? chat({ created: 0 }) : anthropic()
    const inputs = [
      {
        type: "response.refusal.delta",
        item_id: "a",
        output_index: 0,
        content_index: 0,
        delta: "Cannot ",
      },
      {
        type: "response.refusal.delta",
        item_id: "a",
        output_index: 0,
        content_index: 0,
        delta: "comply",
      },
      {
        type: "response.refusal.done",
        item_id: "a",
        output_index: 0,
        content_index: 0,
        refusal: "Cannot comply",
      },
      {
        type: "response.output_text.delta",
        item_id: "b",
        output_index: 1,
        content_index: 0,
        delta: "Second",
      },
      {
        type: "response.output_text.delta",
        item_id: "b",
        output_index: 1,
        content_index: 1,
        delta: "",
      },
      {
        type: "response.output_text.delta",
        item_id: "b",
        output_index: 1,
        content_index: 2,
        delta: "part",
      },
      {
        type: "response.refusal.delta",
        item_id: "b",
        output_index: 1,
        content_index: -1,
        delta: "WRONG",
      },
    ]
    const events = inputs.flatMap((input) =>
      translator.push({ event: null, data: JSON.stringify(input) }),
    )
    const parsed = events.filter((e) => e.data !== "[DONE]").map((e) => JSON.parse(e.data))
    if (dialect === "chat") {
      expect(parsed.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe(
        "Cannot comply\nSecond\npart",
      )
    } else {
      expect(parsed.map((e) => e.delta?.text ?? "").join("")).toBe("Cannot complySecond\npart")
      expect(parsed.filter((e) => e.type === "content_block_start")).toHaveLength(2)
    }
  })
}
