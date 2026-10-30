import { describe, expect, test } from "bun:test"
import { renderErrorBody } from "../../../src/errors/render"
import { openAiResponsesToAnthropicStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { translateUpstreamError } from "../../../src/services/translate/shared/errors"

/**
 * Prod fingerprint: a Codex `response.failed` carrying `context_length_exceeded` on an Anthropic-wire
 * stream rendered as a 500 `api_error` with the code dropped, so the client's overflow recovery
 * (it matches `prompt is too long` / `context_length_exceeded`) never compacted and retried.
 */
const CODEX_OVERFLOW = {
  code: "context_length_exceeded",
  type: "invalid_request_error",
  message: "Your input exceeds the context window of this model.",
}

describe("context overflow renders as a recognisable client error", () => {
  test("Anthropic wire: in-stream response.failed becomes invalid_request_error naming the code", () => {
    const stream = openAiResponsesToAnthropicStream({ id: "msg_fixture", model: "gpt-fixture" })
    stream.push({
      event: "response.created",
      data: JSON.stringify({ type: "response.created", response: { id: "r", model: "m" } }),
    })
    const frames = stream.push({
      event: "response.failed",
      data: JSON.stringify({ type: "response.failed", response: { error: CODEX_OVERFLOW } }),
    })
    const error = frames.find((frame) => frame.event === "error")
    const body: { error: { type: string; message: string } } = JSON.parse(error?.data ?? "null")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toMatch(/^prompt is too long: /)
    expect(body.error.message).toContain("Your input exceeds the context window")
    expect(body.error.message).toContain("(context_length_exceeded)")
  })

  test("Anthropic wire: a non-stream upstream body keeps the code in the message", () => {
    const body = translateUpstreamError({ error: CODEX_OVERFLOW }, 400, "anthropic")
    expect(body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "prompt is too long: Your input exceeds the context window of this model. (context_length_exceeded)",
      },
    })
  })

  test("OpenAI wire: an Anthropic overflow carries the context_length_exceeded code", () => {
    const anthropic = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "prompt is too long: 208310 tokens > 200000 maximum",
      },
    }
    for (const dialect of ["openai-chat", "openai-responses"] as const) {
      expect(translateUpstreamError(anthropic, 400, dialect)).toEqual({
        error: {
          message: "prompt is too long: 208310 tokens > 200000 maximum",
          type: "invalid_request_error",
          param: null,
          code: "context_length_exceeded",
        },
      })
    }
  })

  test("an in-stream overflow on OpenAI wire is a client error, not server_error", () => {
    expect(renderErrorBody("openai-chat", 500, "too long", "context_length_exceeded")).toEqual({
      error: {
        message: "too long",
        type: "invalid_request_error",
        param: null,
        code: "context_length_exceeded",
      },
    })
  })

  test("an Anthropic message already saying so is not prefixed twice", () => {
    const body = renderErrorBody("anthropic", 400, "prompt is too long: 9 tokens > 8 maximum", null)
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "prompt is too long: 9 tokens > 8 maximum" },
    })
  })

  test("other failures are untouched", () => {
    expect(renderErrorBody("anthropic", 500, "boom", "server_error")).toEqual({
      type: "error",
      error: { type: "api_error", message: "boom" },
    })
  })
})

test("Anthropic's own overflow re-rendered on Anthropic wire gains no foreign suffix", () => {
  const anthropic = {
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 9 tokens > 8 maximum" },
  }
  expect(translateUpstreamError(anthropic, 400, "anthropic")).toEqual({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 9 tokens > 8 maximum" },
  })
})
