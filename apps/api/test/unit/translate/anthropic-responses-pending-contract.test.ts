import { expect, test } from "bun:test"
import { translationPair } from "../../../src/services/translate/registry"
import { TranslationStreamError } from "../../../src/services/translate/shared/stream-error"

test("Responses ingress honors its configured pending limit and exposes local overflow", () => {
  const pair = translationPair("openai-responses", "anthropic")
  if (!pair) throw Error("missing pair")
  const translator = pair.stream({
    created: 0,
    model: "fixture",
    fallbackId: "fixture",
    maximumPendingBytes: 1024,
  })
  translator.push({
    event: "content_block_start",
    data: JSON.stringify({ index: 0, content_block: { type: "tool_use", id: "call", name: "f" } }),
  })
  const frames = translator.push({
    event: "content_block_delta",
    data: JSON.stringify({ index: 1, delta: { type: "text_delta", text: "x".repeat(897) } }),
  })
  expect(
    frames.some(
      (frame) => frame.event === "error" && frame.data.includes("translation_pending_overflow"),
    ),
  ).toBe(true)
  const failure = translator.translationFailure?.()
  expect(failure).toBeInstanceOf(TranslationStreamError)
  expect(failure).toMatchObject({ errorClass: "translation_pending_overflow" })
  expect(
    translator.push({
      event: "message_delta",
      data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    }),
  ).toEqual([])
  expect(translator.flush()).toEqual([])
  expect(translator.translationFailure?.()).toBe(failure)
})

test("larger configured cap preserves the same held text until normal completion", () => {
  const pair = translationPair("openai-responses", "anthropic")
  if (!pair) throw Error("missing pair")
  const translator = pair.stream({
    created: 0,
    model: "fixture",
    fallbackId: "fixture",
    maximumPendingBytes: 2048,
  })
  translator.push({
    event: "content_block_start",
    data: JSON.stringify({ index: 0, content_block: { type: "tool_use", id: "call", name: "f" } }),
  })
  const held = translator.push({
    event: "content_block_delta",
    data: JSON.stringify({ index: 1, delta: { type: "text_delta", text: "x".repeat(897) } }),
  })
  expect(held).toEqual([])
  expect(translator.translationFailure?.()).toBe(null)
  const complete = translator.push({
    event: "message_delta",
    data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  })
  expect(complete.some((frame) => frame.event === "response.completed")).toBe(true)
  expect(
    complete.some(
      (frame) =>
        frame.event === "response.output_text.delta" && frame.data.includes("x".repeat(897)),
    ),
  ).toBe(true)
  expect(translator.translationFailure?.()).toBe(null)
})
