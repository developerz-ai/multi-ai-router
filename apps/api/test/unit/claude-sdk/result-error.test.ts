import { describe, expect, test } from "bun:test"
import { classifySdkFailure, renderSdkResponse } from "../../../src/providers"
import { SdkResultError } from "../../../src/providers/claude-sdk/result-error"
import { sdkQueryStream, sdkTurn } from "./fixtures"

/**
 * A `result` that says the turn failed is a failure with a status, not an empty `200`.
 *
 * The production shape this pins (2026-09-05): a subscription whose refresh token had hard-expired
 * answered every request with `{"type":"result","subtype":"success","is_error":true,
 * "api_error_status":null,"terminal_reason":"api_error","result":"Failed to authenticate: OAuth
 * session expired and could not be refreshed"}` — and the renderer, which read only `usage` and
 * `stop_reason` off a `result`, closed an empty message over it.
 */

const PROD_RESULT = {
  is_error: true,
  api_error_status: null,
  terminal_reason: "api_error",
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  stop_reason: null,
}

const TEXT_BLOCK = [
  { type: "text", text: "" },
  { type: "text_delta", text: "hi" },
] as const

describe("a failed result before any content", () => {
  test("is raised with the SDK's own sentence and its structured facts, non-streaming", async () => {
    const stream = sdkQueryStream({ turns: [], result: PROD_RESULT })

    const thrown = await renderSdkResponse({ messages: stream, model: "m", stream: false }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(SdkResultError)
    const error = thrown as SdkResultError
    expect(error.message).toBe(`Claude Code returned an error result: ${PROD_RESULT.result}`)
    expect(error.apiErrorStatus).toBeNull()
    expect(error.terminalReason).toBe("api_error")
    // And it classifies as what it is.
    expect(classifySdkFailure(error).classification.kind).toBe("auth")
  })

  test("is raised before the first byte on a streaming turn too — a real status, not a 200", async () => {
    const stream = sdkQueryStream({ turns: [], result: PROD_RESULT })

    await expect(
      renderSdkResponse({ messages: stream, model: "m", stream: true }),
    ).rejects.toBeInstanceOf(SdkResultError)
  })

  test("an error_during_execution result is read from its `errors` list", async () => {
    const stream = sdkQueryStream({
      turns: [],
      result: {
        subtype: "error_during_execution",
        is_error: true,
        errors: [" Prompt is too long ", ""],
        terminal_reason: "prompt_too_long",
      },
    })

    const thrown = await renderSdkResponse({ messages: stream, model: "m", stream: false }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(SdkResultError)
    expect((thrown as SdkResultError).resultText).toBe("Prompt is too long")
    expect(classifySdkFailure(thrown).classification.signal).toBe("claude-sdk:prompt-too-long")
  })
})

describe("a failed result after content has reached the client", () => {
  test("closes the message it already sent rather than retracting it", async () => {
    const stream = sdkQueryStream({
      turns: [sdkTurn({ blocks: [TEXT_BLOCK] })],
      result: { subtype: "error_max_turns", is_error: true, errors: ["max turns"] },
    })

    const response = await renderSdkResponse({ messages: stream, model: "m", stream: false })
    const body = (await response.json()) as { content: { text: string }[] }

    expect(response.status).toBe(200)
    expect(body.content[0]?.text).toBe("hi")
  })
})
