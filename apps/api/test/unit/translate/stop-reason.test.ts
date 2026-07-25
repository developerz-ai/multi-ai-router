/**
 * `stop_reason` ⇄ `finish_reason` (docs/idea/06-protocol-translation.md#stop-and-finish-reasons).
 */

import { describe, expect, test } from "bun:test"
import {
  CONSERVATIVE_FINISH_REASON,
  CONSERVATIVE_STOP_REASON,
  isAnthropicStopReason,
  isOpenAiFinishReason,
  toAnthropicStopReason,
  toOpenAiFinishReason,
} from "../../../src/services/translate"

describe("anthropic -> openai-chat", () => {
  test("clean, both ways: end_turn, max_tokens, tool_use", () => {
    expect(toOpenAiFinishReason("end_turn")).toEqual({ value: "stop", unrecognized: null })
    expect(toOpenAiFinishReason("max_tokens")).toEqual({ value: "length", unrecognized: null })
    expect(toOpenAiFinishReason("tool_use")).toEqual({ value: "tool_calls", unrecognized: null })
  })

  test("lossy: stop_sequence maps to stop, and which sequence matched is not carried here", () => {
    expect(toOpenAiFinishReason("stop_sequence")).toEqual({ value: "stop", unrecognized: null })
  })

  test("lossy: pause_turn and refusal both collapse to stop", () => {
    expect(toOpenAiFinishReason("pause_turn")).toEqual({ value: "stop", unrecognized: null })
    expect(toOpenAiFinishReason("refusal")).toEqual({ value: "stop", unrecognized: null })
  })

  test("an unrecognized upstream value maps conservatively and is reported, not dropped", () => {
    const result = toOpenAiFinishReason("some_new_reason")
    expect(result.value).toBe(CONSERVATIVE_FINISH_REASON)
    expect(result.unrecognized).toBe("some_new_reason")
  })

  test("null/undefined means not finished yet: absence maps to absence", () => {
    expect(toOpenAiFinishReason(null)).toEqual({ value: null, unrecognized: null })
    expect(toOpenAiFinishReason(undefined)).toEqual({ value: null, unrecognized: null })
  })
})

describe("openai-chat -> anthropic", () => {
  test("clean, both ways: stop, length, tool_calls", () => {
    expect(toAnthropicStopReason("stop")).toEqual({ value: "end_turn", unrecognized: null })
    expect(toAnthropicStopReason("length")).toEqual({ value: "max_tokens", unrecognized: null })
    expect(toAnthropicStopReason("tool_calls")).toEqual({ value: "tool_use", unrecognized: null })
  })

  test("lossy: content_filter maps to end_turn, the refusal reason is lost", () => {
    expect(toAnthropicStopReason("content_filter")).toEqual({
      value: "end_turn",
      unrecognized: null,
    })
  })

  test("the deprecated single-function form reads as a tool call, not plain text", () => {
    expect(toAnthropicStopReason("function_call")).toEqual({
      value: "tool_use",
      unrecognized: null,
    })
  })

  test("an unrecognized upstream value maps conservatively and is reported", () => {
    const result = toAnthropicStopReason("brand_new_value")
    expect(result.value).toBe(CONSERVATIVE_STOP_REASON)
    expect(result.unrecognized).toBe("brand_new_value")
  })

  test("a value colliding with Object.prototype does not resolve through the prototype chain", () => {
    const result = toAnthropicStopReason("toString")
    expect(result.value).toBe(CONSERVATIVE_STOP_REASON)
    expect(result.unrecognized).toBe("toString")
  })

  test("null/undefined maps to absence", () => {
    expect(toAnthropicStopReason(null)).toEqual({ value: null, unrecognized: null })
    expect(toAnthropicStopReason(undefined)).toEqual({ value: null, unrecognized: null })
  })
})

describe("membership guards", () => {
  test("isAnthropicStopReason recognizes exactly the closed set", () => {
    expect(isAnthropicStopReason("end_turn")).toBe(true)
    expect(isAnthropicStopReason("bogus")).toBe(false)
  })

  test("isOpenAiFinishReason recognizes exactly the closed set", () => {
    expect(isOpenAiFinishReason("stop")).toBe(true)
    expect(isOpenAiFinishReason("bogus")).toBe(false)
  })
})
