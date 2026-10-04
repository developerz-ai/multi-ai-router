import { expect, test } from "bun:test"
import { openAiChatToAnthropicStream } from "../../../src/services/translate/openai-chat-to-anthropic/stream"
import { openAiResponsesToAnthropicStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatStream } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"
import type { SseEvent, StreamTranslator } from "../../../src/services/translate/sse/emit"

function push(t: StreamTranslator, event: object): readonly SseEvent[] {
  return t.push({ event: null, data: JSON.stringify(event) })
}
function text(events: readonly SseEvent[]) {
  return events
    .filter((e) => e.data !== "[DONE]")
    .map((e) => JSON.parse(e.data))
    .map(
      (e) => e.choices?.[0]?.delta?.content ?? (e.delta?.type === "text_delta" ? e.delta.text : ""),
    )
    .join("")
}
const factories = [
  () => openAiResponsesToAnthropicStream(),
  () => openAiResponsesToOpenAiChatStream({ created: 1 }),
]
for (const [index, factory] of factories.entries()) {
  test(`Responses ${index}: done-only text and refusal are recovered once`, () => {
    const t = factory()
    const events = [
      ...push(t, {
        type: "response.output_text.done",
        item_id: "a",
        content_index: 0,
        text: "hello",
      }),
      ...push(t, {
        type: "response.output_text.done",
        item_id: "a",
        content_index: 0,
        text: "hello",
      }),
      ...push(t, { type: "response.refusal.done", item_id: "a", content_index: 1, refusal: "no" }),
    ]
    expect(text(events)).toBe("hello\nno")
  })
  test(`Responses ${index}: partial deltas plus final snapshot emit only the suffix`, () => {
    const t = factory()
    const events = [
      ...push(t, {
        type: "response.output_text.delta",
        item_id: "a",
        content_index: 0,
        delta: "he",
      }),
      ...push(t, {
        type: "response.output_text.delta",
        item_id: "a",
        content_index: 0,
        delta: "l",
      }),
      ...push(t, {
        type: "response.output_text.done",
        item_id: "a",
        content_index: 0,
        text: "hello",
      }),
    ]
    expect(text(events)).toBe("hello")
  })
  test(`Responses ${index}: incompatible final snapshot emits an error and cannot complete successfully`, () => {
    const t = factory()
    push(t, { type: "response.output_text.delta", item_id: "a", content_index: 0, delta: "hello" })
    const bad = push(t, {
      type: "response.output_text.done",
      item_id: "a",
      content_index: 0,
      text: "other",
    })
    expect(bad.some((e) => JSON.parse(e.data === "[DONE]" ? "{}" : e.data).error)).toBe(true)
    expect(push(t, { type: "response.completed", response: { status: "completed" } })).toEqual([])
  })
  test(`Responses ${index}: final arguments fill only the missing call suffix`, () => {
    const t = factory()
    const events = [
      ...push(t, {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "a", call_id: "call", name: "f" },
      }),
      ...push(t, { type: "response.function_call_arguments.delta", item_id: "a", delta: '{"x":' }),
      ...push(t, {
        type: "response.function_call_arguments.done",
        item_id: "a",
        arguments: '{"x":1}',
      }),
      ...push(t, { type: "response.completed", response: { status: "completed" } }),
    ]
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data))
    const args = events
      .map(
        (e) =>
          e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ??
          e.delta?.partial_json ??
          "",
      )
      .join("")
    expect(args).toBe('{"x":1}')
  })
}
test("interleaved Chat text never closes a tool before its later arguments", () => {
  const t = openAiChatToAnthropicStream()
  const events = [
    ...push(t, {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x":' } }],
          },
        },
      ],
    }),
    ...push(t, { choices: [{ delta: { content: "between" } }] }),
    ...push(t, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
    }),
    ...t.push({ event: null, data: "[DONE]" }),
  ].map((e) => JSON.parse(e.data))
  expect(
    events
      .filter((e) => e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json)
      .join(""),
  ).toBe('{"x":1}')
  expect(
    events
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join(""),
  ).toBe("between")
})
