import { expect, test } from "bun:test"
import { z } from "zod"
import { openAiResponsesToAnthropicStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import type { SseEvent, StreamTranslator } from "../../../src/services/translate/sse/emit"

const emitted = z.looseObject({
  type: z.string(),
  content_block: z.looseObject({ type: z.string(), id: z.string().optional() }).optional(),
  delta: z
    .looseObject({
      type: z.string(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
    })
    .optional(),
})
function push(t: StreamTranslator, event: object) {
  return t.push({ event: null, data: JSON.stringify(event) })
}
function parsed(events: readonly SseEvent[]) {
  return events.map((event) => emitted.parse(JSON.parse(event.data)))
}
test("Anthropic tool arguments follow added ID/output aliases without duplicating final snapshots", () => {
  const t = openAiResponsesToAnthropicStream(),
    out: SseEvent[] = []
  out.push(
    ...push(t, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc", call_id: "public-call", name: "f" },
    }),
  )
  out.push(
    ...push(t, { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"x":' }),
  )
  expect(
    parsed(out)
      .map((event) => event.delta?.partial_json ?? "")
      .join(""),
  ).toBe('{"x":')
  out.push(
    ...push(t, {
      type: "response.function_call_arguments.done",
      item_id: "fc",
      arguments: '{"x":1}',
    }),
  )
  out.push(
    ...push(t, {
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: '{"x":1}',
    }),
  )
  const events = parsed(out)
  expect(events.filter((e) => e.content_block?.type === "tool_use")).toHaveLength(1)
  expect(events.find((e) => e.content_block?.type === "tool_use")?.content_block?.id).toBe(
    "public-call",
  )
  expect(events.map((e) => e.delta?.partial_json ?? "").join("")).toBe('{"x":1}')
  expect(t.translationFailure?.()).toBeNull()
})
test("text ID/index aliases preserve one Hello block", () => {
  const t = openAiResponsesToAnthropicStream(),
    out: SseEvent[] = []
  out.push(
    ...push(t, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg" },
    }),
  )
  out.push(
    ...push(t, {
      type: "response.output_text.delta",
      item_id: "msg",
      content_index: 0,
      delta: "Hel",
    }),
  )
  out.push(
    ...push(t, {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "lo",
    }),
  )
  const events = parsed(out)
  expect(events.filter((e) => e.content_block?.type === "text")).toHaveLength(1)
  expect(events.map((e) => e.delta?.text ?? "").join("")).toBe("Hello")
})
test("unkeyed live arguments follow their current added call", () => {
  const t = openAiResponsesToAnthropicStream(),
    out: SseEvent[] = []
  out.push(
    ...push(t, {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "public", name: "f" },
    }),
  )
  out.push(...push(t, { type: "response.function_call_arguments.delta", delta: '{"ok":true}' }))
  expect(
    parsed(out)
      .map((e) => e.delta?.partial_json ?? "")
      .join(""),
  ).toBe('{"ok":true}')
})
for (const keyed of [false, true]) {
  test(`empty sequential announcements consume bounded identity state (keyed=${keyed})`, () => {
    const t = openAiResponsesToAnthropicStream({ maximumPendingBytes: 1024 })
    for (let i = 0; i < 20; i++) {
      push(t, {
        type: "response.output_item.added",
        ...(keyed ? { output_index: i } : {}),
        item: {
          type: "function_call",
          ...(keyed ? { id: `fc${i}` } : {}),
          name: "f",
          call_id: `call${i}`,
        },
      })
      push(t, {
        type: "response.output_item.done",
        ...(keyed ? { output_index: i } : {}),
        item: {
          type: "function_call",
          ...(keyed ? { id: `fc${i}` } : {}),
          name: "f",
          call_id: `call${i}`,
        },
      })
    }
    expect(t.translationFailure?.()).toMatchObject({ errorClass: "translation_pending_overflow" })
  })
}
