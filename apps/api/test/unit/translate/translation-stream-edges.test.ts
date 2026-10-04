import { expect, test } from "bun:test"
import { anthropicToOpenAiChatStream } from "../../../src/services/translate/anthropic-to-openai-chat/stream"
import { anthropicToOpenAiResponsesStream } from "../../../src/services/translate/anthropic-to-openai-responses/stream"
import { openAiChatToAnthropicStream } from "../../../src/services/translate/openai-chat-to-anthropic/stream"
import { openAiChatToOpenAiResponsesStream } from "../../../src/services/translate/openai-chat-to-openai-responses/stream"

function frame(body: unknown) {
  return { event: null, data: JSON.stringify(body) }
}
test("indexed late arguments stay attached and tool stop is inferred only at termination", () => {
  const t = openAiChatToAnthropicStream()
  const start = t.push(
    frame({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x":' } }],
          },
        },
      ],
    }),
  )
  const finish = t.push(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }))
  expect(finish).toEqual([])
  const late = t.push(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }),
  )
  const end = t.push({ event: null, data: "[DONE]" })
  const payloads = [...start, ...late, ...end].map((e) => JSON.parse(e.data))
  expect(
    payloads
      .filter((e) => e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json)
      .join(""),
  ).toBe('{"x":1}')
  expect(payloads.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use")
})
test("nonempty Anthropic arguments never gain an empty-object suffix", () => {
  for (const t of [
    anthropicToOpenAiChatStream({ created: 1 }),
    anthropicToOpenAiResponsesStream({ created: 1 }),
  ]) {
    const start = t.push(
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "a", name: "f" },
      }),
    )
    const delta = t.push(
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      }),
    )
    const stop = t.push(frame({ type: "content_block_stop", index: 0 }))
    const payloads = [...start, ...delta, ...stop].map((e) => JSON.parse(e.data))
    if (payloads.some((e) => Array.isArray(e.choices))) {
      expect(
        payloads
          .flatMap((e) => e.choices ?? [])
          .flatMap((e) => e.delta?.tool_calls ?? [])
          .map((e) => e.function.arguments ?? "")
          .join(""),
      ).toBe('{"x":1}')
    } else {
      expect(
        payloads
          .filter((e) => e.type === "response.function_call_arguments.done")
          .map((e) => e.arguments),
      ).toEqual(['{"x":1}'])
    }
  }
})
test("a transport-truncated tool stream receives no invented completed arguments", () => {
  for (const t of [
    openAiChatToAnthropicStream(),
    openAiChatToOpenAiResponsesStream({ created: 1 }),
    anthropicToOpenAiChatStream({ created: 1 }),
    anthropicToOpenAiResponsesStream({ created: 1 }),
  ]) {
    t.push(
      frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{" } }] },
          },
        ],
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "a", name: "f" },
      }),
    )
    expect(t.flush()).toEqual([])
  }
})
