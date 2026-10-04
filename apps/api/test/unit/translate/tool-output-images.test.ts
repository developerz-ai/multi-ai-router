import { expect, test } from "bun:test"
import { anthropicToOpenAiChatRequest as anthropicChat } from "../../../src/services/translate/anthropic-to-openai-chat/request"
import { anthropicToOpenAiResponsesRequest as anthropicResponses } from "../../../src/services/translate/anthropic-to-openai-responses/request"
import { openAiResponsesToAnthropicRequest as responsesAnthropic } from "../../../src/services/translate/openai-responses-to-anthropic/request"
import { openAiResponsesToOpenAiChatRequest as responsesChat } from "../../../src/services/translate/openai-responses-to-openai-chat/request"

const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "A" },
} as const
const request = {
  model: "fixture",
  max_tokens: 32,
  messages: [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "A", input: {} },
        { type: "tool_use", id: "b", name: "B", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "a",
          content: [{ type: "text", text: "first" }, image],
        },
        { type: "tool_result", tool_use_id: "b", content: "second" },
        { type: "text", text: "Explain" },
      ],
    },
  ],
}
const input = [
  { type: "function_call", call_id: "a", name: "A", arguments: "{}" },
  { type: "function_call", call_id: "b", name: "B", arguments: "{}" },
  {
    type: "function_call_output",
    call_id: "a",
    output: [
      { type: "input_text", text: "first" },
      { type: "input_image", image_url: "data:image/png;base64,A" },
    ],
  },
  { type: "function_call_output", call_id: "b", output: "second" },
]
test("Anthropic parallel replies precede every hoisted Chat image", () => {
  const out = anthropicChat(request)
  expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"])
  expect(out.messages[0]?.tool_calls?.map((call) => call.id)).toEqual(["a", "b"])
  expect(out.messages[1]).toMatchObject({ tool_call_id: "a", content: "first" })
  expect(out.messages[2]).toMatchObject({ tool_call_id: "b", content: "second" })
  expect(out.messages[3]?.content).toEqual([
    { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
    { type: "text", text: "Explain" },
  ])
})
test("Anthropic Responses sibling preserves contiguous output run before hoisted image", () => {
  const out = anthropicResponses(request)
  expect(out.input.map((i) => i.type)).toEqual([
    "function_call",
    "function_call",
    "function_call_output",
    "function_call_output",
    "message",
  ])
})
test("Responses image outputs become Chat tool text then one ordered user image carrier", () => {
  const out = responsesChat({ model: "fixture", input })
  expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"])
  expect(out.messages[0]?.tool_calls?.map((call) => call.id)).toEqual(["a", "b"])
  expect(out.messages[1]).toMatchObject({ tool_call_id: "a", content: "first" })
  expect(out.messages[2]).toMatchObject({ tool_call_id: "b", content: "second" })
  expect(out.messages[3]?.content).toEqual([
    { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
  ])
})
test("Responses image stays native inside Anthropic tool result", () => {
  const out = responsesAnthropic({ model: "fixture", input })
  expect(out.messages[1]?.content[0]).toEqual({
    type: "tool_result",
    tool_use_id: "a",
    content: [{ type: "text", text: "first" }, image],
  })
  expect(out.messages[1]?.content[1]).toEqual({
    type: "tool_result",
    tool_use_id: "b",
    content: "second",
  })
})

for (const [name, translate] of [
  ["chat", responsesChat],
  ["anthropic", responsesAnthropic],
] as const) {
  test(`${name} rejects stored and unsupported output content without silently losing data`, () => {
    for (const part of [
      { type: "input_image", file_id: "private" },
      { type: "input_image", image_url: "" },
      { type: "input_audio", data: "opaque" },
    ]) {
      expect(() =>
        translate({
          model: "fixture",
          input: [input[0], { type: "function_call_output", call_id: "a", output: [part] }],
        }),
      ).toThrow()
    }
  })
}
test("multiple image replies preserve IDs/image order; hoist stops before next assistant turn", () => {
  const out = responsesChat({
    model: "fixture",
    input: [
      ...input.slice(0, 3),
      {
        type: "function_call_output",
        call_id: "b",
        output: [
          { type: "input_text", text: "second" },
          { type: "input_image", image_url: "https://example.invalid/second.png" },
        ],
      },
      { role: "assistant", content: "Next" },
    ],
  })
  expect(out.messages.map((m) => m.role)).toEqual([
    "assistant",
    "tool",
    "tool",
    "user",
    "assistant",
  ])
  expect(out.messages[3]?.content).toEqual([
    { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
    { type: "image_url", image_url: { url: "https://example.invalid/second.png" } },
  ])
  expect(out.messages[4]?.content).toBe("Next")
})

test("interspersed user text cannot split Anthropic Responses parallel replies", () => {
  const turn = request.messages[1]
  if (turn === undefined) throw new Error("Missing fixture tool turn")
  const blocks = turn.content
  const out = anthropicResponses({
    ...request,
    messages: [request.messages[0], { ...turn, content: [blocks[0], blocks[2], blocks[1]] }],
  })
  expect(out.input.map((i) => i.type)).toEqual([
    "function_call",
    "function_call",
    "function_call_output",
    "function_call_output",
    "message",
  ])
})
test("image extraction retains original field indexes for unsupported adjacent data", () => {
  expect(() =>
    responsesChat({
      model: "fixture",
      input: [
        input[0],
        {
          type: "function_call_output",
          call_id: "a",
          output: [
            { type: "input_image", image_url: "https://example.invalid/first.png" },
            { type: "input_audio", data: "opaque" },
          ],
        },
      ],
    }),
  ).toThrow("input[1].output[1].type")
})

test("deferred Anthropic user carrier preserves interspersed text and all image order", () => {
  const imageB = { type: "image", source: { type: "url", url: "https://example.invalid/B.png" } }
  const imageC = { type: "image", source: { type: "url", url: "https://example.invalid/C.png" } }
  const mixed = {
    ...request,
    messages: [
      request.messages[0],
      {
        role: "user",
        content: [
          request.messages[1]?.content[0],
          { type: "text", text: "Between" },
          {
            type: "tool_result",
            tool_use_id: "b",
            content: [{ type: "text", text: "second" }, imageB],
          },
          imageC,
        ],
      },
    ],
  }
  const chat = anthropicChat(mixed)
  expect(chat.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"])
  expect(chat.messages[1]).toMatchObject({ tool_call_id: "a", content: "first" })
  expect(chat.messages[2]).toMatchObject({ tool_call_id: "b", content: "second" })
  expect(chat.messages[3]?.content).toEqual([
    { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
    { type: "text", text: "Between" },
    { type: "image_url", image_url: { url: "https://example.invalid/B.png" } },
    { type: "image_url", image_url: { url: "https://example.invalid/C.png" } },
  ])
  const responses = anthropicResponses(mixed)
  expect(responses.input.map((i) => i.type)).toEqual([
    "function_call",
    "function_call",
    "function_call_output",
    "function_call_output",
    "message",
  ])
  expect(responses.input[2]).toMatchObject({ call_id: "a", output: "first" })
  expect(responses.input[3]).toMatchObject({ call_id: "b", output: "second" })
  expect(responses.input[4]).toMatchObject({
    role: "user",
    content: [
      { type: "input_image", image_url: "data:image/png;base64,A" },
      { type: "input_text", text: "Between" },
      { type: "input_image", image_url: "https://example.invalid/B.png" },
      { type: "input_image", image_url: "https://example.invalid/C.png" },
    ],
  })
})

test("stateless reasoning does not split parallel results or ordered image carrier", () => {
  const out = responsesChat({
    model: "fixture",
    input: [
      ...input.slice(0, 3),
      { type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] },
      {
        type: "function_call_output",
        call_id: "b",
        output: [
          { type: "input_text", text: "second" },
          { type: "input_image", image_url: "https://example.invalid/B.png" },
        ],
      },
    ],
  })
  expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"])
  expect(out.messages[0]?.tool_calls?.map((call) => call.id)).toEqual(["a", "b"])
  expect(out.messages.slice(1, 3).map((m) => m.tool_call_id)).toEqual(["a", "b"])
  expect(out.messages[3]?.content).toEqual([
    { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
    { type: "image_url", image_url: { url: "https://example.invalid/B.png" } },
  ])
  expect(JSON.stringify(out)).not.toContain("hidden")
})
test("stateless reasoning between assistant calls preserves one group; encrypted state remains refused", () => {
  const summary = { type: "reasoning", summary: [{ type: "summary_text", text: "hidden" }] }
  const out = responsesChat({
    model: "fixture",
    input: [input[0], summary, input[1], input[2], input[3]],
  })
  expect(out.messages[0]?.tool_calls?.map((call) => call.id)).toEqual(["a", "b"])
  expect(out.messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"])
  expect(() =>
    responsesChat({
      model: "fixture",
      input: [input[0], { ...summary, encrypted_content: "opaque" }, input[1], input[2], input[3]],
    }),
  ).toThrow()
})
