import { expect, test } from "bun:test"
import {
  isModelOutputFrame,
  observingModelOutput,
} from "../../../src/services/dataplane/model-output"

test("envelope frames are not model output", () => {
  expect(isModelOutputFrame("anthropic", { type: "message_start" }, "message_start")).toBe(false)
  expect(isModelOutputFrame("anthropic", { type: "ping" }, "ping")).toBe(false)
  expect(
    isModelOutputFrame(
      "openai-chat",
      { choices: [{ delta: { role: "assistant", content: "" } }] },
      undefined,
    ),
  ).toBe(false)
  expect(isModelOutputFrame("openai-responses", { type: "response.created" }, undefined)).toBe(
    false,
  )
})

test("content, thinking, and tool deltas are model output in every dialect", () => {
  expect(isModelOutputFrame("anthropic", { type: "content_block_delta" }, undefined)).toBe(true)
  expect(
    isModelOutputFrame(
      "openai-chat",
      { choices: [{ delta: { reasoning_content: "hm" } }] },
      undefined,
    ),
  ).toBe(true)
  expect(
    isModelOutputFrame(
      "openai-chat",
      { choices: [{ delta: { tool_calls: [{ index: 0 }] } }] },
      undefined,
    ),
  ).toBe(true)
  expect(
    isModelOutputFrame("openai-responses", { type: "response.output_text.delta" }, undefined),
  ).toBe(true)
})

test("the wrapper keeps the driver's policy and verdict", () => {
  let seen = 0
  const verdict = { kind: "server-error", status: 500, retryable: true, signal: "x" } as const
  const wrapped = observingModelOutput(
    "anthropic",
    { terminalPolicy: "require-completion", inspectPayload: () => verdict },
    () => {
      seen++
    },
  )
  expect(wrapped.terminalPolicy).toBe("require-completion")
  expect(wrapped.inspectPayload?.({ type: "content_block_delta" }, undefined)).toBe(verdict)
  expect(seen).toBe(1)
  expect(observingModelOutput("anthropic", undefined, () => {}).terminalPolicy).toBe(
    "evidence-only",
  )
})
