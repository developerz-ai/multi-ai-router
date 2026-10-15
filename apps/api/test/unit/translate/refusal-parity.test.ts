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
/**
 * openai-chat states a refusal in its own field (`message.refusal`, `delta.refusal`), so a
 * structured-output caller never finds the refusal sentence inside the JSON it parses. Production
 * fingerprint: before 2.28.0 both halves glued it onto `content` ("Answer\nCannot comply").
 */
test("mixed text and refusal: Chat carries the refusal in its own field, streamed and collected alike", () => {
  const t = chat({ created: 0 })
  const events = frames.flatMap((frame) =>
    t.push({ event: frame.type, data: JSON.stringify(frame) }),
  )
  const deltas = events.map((e) => JSON.parse(e.data).choices?.[0]?.delta ?? {})
  const streamedContent = deltas.map((d) => d.content ?? "").join("")
  const streamedRefusal = deltas.map((d) => d.refusal ?? "").join("")
  const message = (
    chatResponse(body, { created: 0 }).body as {
      choices: { message: { content: string | null; refusal?: string } }[]
    }
  ).choices[0]?.message
  if (message === undefined) throw new Error("Missing fixture completion")
  expect(message.content).toBe("Answer")
  expect(message.refusal).toBe("Cannot comply")
  expect(streamedContent).toBe("Answer")
  expect(streamedRefusal).toBe("Cannot comply")
})

test("a refusal-only answer is content: null plus message.refusal, finish_reason stop", () => {
  const out = chatResponse(
    {
      id: "r",
      model: "m",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg",
          role: "assistant",
          content: [{ type: "refusal", refusal: "Cannot comply" }],
        },
      ],
    },
    { created: 0 },
  ).body as {
    choices: { message: { content: string | null; refusal?: string }; finish_reason: string }[]
  }
  expect(out.choices[0]?.message).toEqual({
    role: "assistant",
    content: null,
    refusal: "Cannot comply",
  })
  expect(out.choices[0]?.finish_reason).toBe("stop")
})

test("an answer with no refusal carries no refusal field", () => {
  const out = chatResponse(
    {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }],
    },
    { created: 0 },
  ).body as { choices: { message: Record<string, unknown> }[] }
  expect(out.choices[0]?.message).not.toHaveProperty("refusal")
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
      expect(parsed.map((e) => e.choices?.[0]?.delta?.content ?? "").join("")).toBe("Second\npart")
      expect(parsed.map((e) => e.choices?.[0]?.delta?.refusal ?? "").join("")).toBe("Cannot comply")
    } else {
      expect(parsed.map((e) => e.delta?.text ?? "").join("")).toBe("Cannot complySecond\npart")
      expect(parsed.filter((e) => e.type === "content_block_start")).toHaveLength(2)
    }
  })
}
