import { expect, test } from "bun:test"
import type { TranslationDrop } from "../../../src/services/translate"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiChatResponse,
  anthropicToOpenAiChatStream,
  anthropicToOpenAiResponsesRequest,
  anthropicToOpenAiResponsesResponse,
  anthropicToOpenAiResponsesStream,
} from "../../../src/services/translate"
import {
  toOpenAiFinishReason,
  toResponsesCompletion,
} from "../../../src/services/translate/shared/stop-reason"

const reason = "model_context_window_exceeded"
test("documented context-window stop is recognized truncation", () => {
  const stop = toOpenAiFinishReason(reason)
  expect(stop).toEqual({ value: "length", unrecognized: null })
  expect(toResponsesCompletion(stop.value)).toEqual({
    status: "incomplete",
    incompleteReason: "max_output_tokens",
  })
})
test("context truncation survives both nonstream response dialects", () => {
  const body = { id: "fixture", content: [{ type: "text", text: "partial" }], stop_reason: reason }
  expect(anthropicToOpenAiChatResponse(body, { created: 1 }).body).toMatchObject({
    choices: [{ finish_reason: "length" }],
  })
  expect(anthropicToOpenAiResponsesResponse(body, { created: 1 }).body).toMatchObject({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  })
})
test("context truncation survives both streaming response dialects", () => {
  for (const target of ["chat", "responses"] as const) {
    const translator =
      target === "chat"
        ? anthropicToOpenAiChatStream({ created: 1 })
        : anthropicToOpenAiResponsesStream({ created: 1 })
    const events = translator.push({
      event: "message_delta",
      data: JSON.stringify({ type: "message_delta", delta: { stop_reason: reason } }),
    })
    const payloads = events.map((e) => JSON.parse(e.data))
    expect(translator.unrecognizedStopReason()).toBeNull()
    if (target === "chat")
      expect(payloads[0]).toMatchObject({ choices: [{ finish_reason: "length" }] })
    else
      expect(payloads.find((e) => e.type === "response.incomplete")?.response).toMatchObject({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      })
  }
})
for (const [dialect, translate] of [
  ["chat", anthropicToOpenAiChatRequest],
  ["responses", anthropicToOpenAiResponsesRequest],
] as const) {
  test(`${dialect} drops and reports top-level file image without losing adjacent text`, () => {
    const drops: TranslationDrop[] = []
    const output = translate(
      {
        model: "m",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              { type: "image", source: { type: "file", file_id: "file_fixture" } },
            ],
          },
        ],
      },
      { onDrop: (drop) => drops.push(drop) },
    )
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ field: "messages[0].content[1]" })
    expect(drops[0]?.reason).toContain("file")
    expect(JSON.stringify(output)).toContain("inspect")
    expect(JSON.stringify(output)).not.toContain("file_fixture")
    expect(JSON.stringify(output)).not.toContain("data:undefined")
  })
  test(`${dialect} drops nested file image and preserves paired tool result`, () => {
    const drops: TranslationDrop[] = []
    const output = translate(
      {
        model: "m",
        max_tokens: 100,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "a", name: "f", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "a",
                content: [
                  { type: "text", text: "result" },
                  { type: "image", source: { type: "file", file_id: "file_fixture" } },
                ],
              },
            ],
          },
        ],
      },
      { onDrop: (drop) => drops.push(drop) },
    )
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ field: "messages[1].content[0].content[1]" })
    expect(JSON.stringify(output)).toContain("result")
    expect(JSON.stringify(output)).toContain('"a"')
    expect(JSON.stringify(output)).not.toContain("file_fixture")
  })
}

import {
  openAiChatToAnthropicResponse,
  openAiChatToAnthropicStream,
} from "../../../src/services/translate"

test("known nonstream content filter does not become permission to execute a tool", () => {
  const tool = { id: "a", type: "function", function: { name: "f", arguments: "{}" } }
  expect(
    openAiChatToAnthropicResponse({
      choices: [{ index: 0, message: { tool_calls: [tool] }, finish_reason: "content_filter" }],
    }).body,
  ).toMatchObject({ stop_reason: "end_turn" })
})
test("known streaming content filter does not become permission to execute a tool", () => {
  const tool = { id: "a", type: "function", function: { name: "f", arguments: "{}" } }
  const stream = openAiChatToAnthropicStream()
  stream.push({
    event: null,
    data: JSON.stringify({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ ...tool, index: 0 }] },
          finish_reason: "content_filter",
        },
      ],
    }),
  })
  const events = stream.push({ event: null, data: "[DONE]" }).map((e) => JSON.parse(e.data))
  expect(events.find((e) => e.type === "message_delta")?.delta.stop_reason).toBe("end_turn")
})
