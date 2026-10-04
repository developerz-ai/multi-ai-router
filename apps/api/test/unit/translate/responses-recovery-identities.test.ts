import { expect, test } from "bun:test"
import { openAiResponsesToAnthropicStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { createResponsesSnapshotRecovery } from "../../../src/services/translate/shared/responses-snapshot-recovery"
import type { SseEvent, StreamTranslator } from "../../../src/services/translate/sse/emit"

function push(t: StreamTranslator, event: object): readonly SseEvent[] {
  return t.push({ event: null, data: JSON.stringify(event) })
}

test("item and output-index identities recover one suffix without duplication", () => {
  const recovery = createResponsesSnapshotRecovery()
  recovery({
    type: "response.output_text.delta",
    item_id: "a",
    output_index: 0,
    content_index: 0,
    delta: "he",
  })
  expect(
    recovery({
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      text: "hello",
    }).event.delta,
  ).toBe("llo")
  expect(
    recovery({ type: "response.output_text.done", item_id: "a", content_index: 0, text: "hello" })
      .event.delta,
  ).toBe("")
})

test("a reused output index cannot silently join distinct item IDs", () => {
  const recovery = createResponsesSnapshotRecovery()
  recovery({
    type: "response.output_text.delta",
    item_id: "a",
    output_index: 0,
    content_index: 0,
    delta: "a",
  })
  expect(
    recovery({
      type: "response.output_text.done",
      item_id: "b",
      output_index: 0,
      content_index: 0,
      text: "ab",
    }).error,
  ).toBeDefined()
})

test("text item boundaries survive deferral behind an open tool", () => {
  const t = openAiResponsesToAnthropicStream()
  push(t, {
    type: "response.output_item.added",
    item: { type: "function_call", id: "a", call_id: "call", name: "f" },
  })
  push(t, { type: "response.output_text.delta", item_id: "m1", content_index: 0, delta: "one" })
  push(t, { type: "response.output_text.delta", item_id: "m2", content_index: 0, delta: "two" })
  const out = push(t, { type: "response.completed", response: { status: "completed" } }).map((e) =>
    JSON.parse(e.data),
  )
  expect(out.filter((e) => e.content_block?.type === "text")).toHaveLength(2)
  expect(out.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text)).toEqual([
    "one",
    "two",
  ])
})
