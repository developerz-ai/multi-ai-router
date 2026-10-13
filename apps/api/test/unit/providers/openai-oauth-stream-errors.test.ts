import { describe, expect, test } from "bun:test"
import {
  CODEX_STREAM_ERROR_REQUEST_CODES,
  inspectCodexStreamFrame,
} from "../../../src/providers/drivers/openai-oauth-stream-errors"

describe("inspectCodexStreamFrame", () => {
  test("a non-error frame is O(1) — only `type` is read; the hook returns null", () => {
    // A `response.output_text.delta` is a content frame, not a terminal. The hook must not read
    // any other field, must not allocate, and must return null so the existing readResponseTerminal
    // path takes over. The frame is shaped with extra noise to prove the hook stopped at `type`.
    const frame = {
      type: "response.output_text.delta",
      delta: "x".repeat(10_000),
      response: { error: { code: "invalid_prompt", message: "would-be read" } },
    }
    const verdict = inspectCodexStreamFrame(frame, "response.output_text.delta")
    expect(verdict).toBeNull()
  })

  test("a bare error event with top-level `code` is classified from the code, not the event type", () => {
    for (const code of CODEX_STREAM_ERROR_REQUEST_CODES) {
      const verdict = inspectCodexStreamFrame(
        { type: "error", code, message: "fixture failure" },
        "error",
      )
      expect(verdict).toEqual({
        kind: "invalid-request",
        status: 200,
        retryable: false,
        signal: `codex:stream-error:${code}`,
        rateLimit: null,
        message: "fixture failure",
      })
    }
  })

  test("a response.failed with nested `error.code` is classified from the nested code", () => {
    const verdict = inspectCodexStreamFrame(
      {
        type: "response.failed",
        response: { error: { code: "invalid_prompt", message: "fixture failure" } },
      },
      "response.failed",
    )
    expect(verdict).toEqual({
      kind: "invalid-request",
      status: 200,
      retryable: false,
      signal: "codex:stream-error:invalid_prompt",
      rateLimit: null,
      message: "fixture failure",
    })
  })

  test("request-shaped codes are not retryable and never strike the breaker", () => {
    const verdict = inspectCodexStreamFrame({ type: "error", code: "invalid_prompt" }, "error")
    expect(verdict).not.toBeNull()
    expect(verdict?.retryable).toBe(false)
    expect(verdict?.kind).toBe("invalid-request")
  })

  test("in-stream rate_limit_exceeded classifies rate-limited; observer forces rateLimit null", () => {
    const verdict = inspectCodexStreamFrame(
      { type: "response.failed", response: { error: { code: "rate_limit_exceeded" } } },
      "response.failed",
    )
    expect(verdict).toEqual({
      kind: "rate-limited",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:rate_limit_exceeded",
      rateLimit: null,
      message: undefined,
    })
  })

  test("in-stream usage_limit_reached classifies rate-limited", () => {
    const verdict = inspectCodexStreamFrame({ type: "error", code: "usage_limit_reached" }, "error")
    expect(verdict).toEqual({
      kind: "rate-limited",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:usage_limit_reached",
      rateLimit: null,
      message: undefined,
    })
  })

  test("in-stream account_deactivated classifies credits-exhausted", () => {
    const verdict = inspectCodexStreamFrame(
      { type: "response.failed", response: { error: { code: "account_deactivated" } } },
      "response.failed",
    )
    expect(verdict).toEqual({
      kind: "credits-exhausted",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:account_deactivated",
      rateLimit: null,
      message: undefined,
    })
  })

  test.each([
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
  ])(
    "in-stream %s classifies credits-exhausted, as the Codex CLI's QuotaExceeded (#206)",
    (code) => {
      // The shape the Codex CLI's own test feeds its stream parser (openai/codex
      // codex-rs/codex-api/src/sse/responses.rs, `quota_exceeded_error_is_fatal`).
      const verdict = inspectCodexStreamFrame(
        {
          type: "response.failed",
          response: {
            status: "failed",
            error: { code, message: "You exceeded your current quota" },
          },
        },
        "response.failed",
      )
      expect(verdict?.kind).toBe("credits-exhausted")
      expect(verdict?.signal).toBe(`codex:stream-error:${code}`)
    },
  )

  test("a nested error type insufficient_quota with no code classifies credits-exhausted", () => {
    const verdict = inspectCodexStreamFrame(
      { type: "error", error: { type: "insufficient_quota" } },
      "error",
    )
    expect(verdict?.kind).toBe("credits-exhausted")
    expect(verdict?.signal).toBe("codex:stream-error:insufficient_quota")
  })

  test("an unknown code is fail-closed server-error with the closed `other` signal", () => {
    const verdict = inspectCodexStreamFrame(
      { type: "error", code: "some_made_up_code", message: "fixture failure" },
      "error",
    )
    expect(verdict).toEqual({
      kind: "server-error",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:other",
      rateLimit: null,
      message: "fixture failure",
    })
  })

  test("a missing code is fail-closed server-error with the closed `other` signal", () => {
    const verdict = inspectCodexStreamFrame({ type: "error", message: "fixture failure" }, "error")
    expect(verdict).toEqual({
      kind: "server-error",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:other",
      rateLimit: null,
      message: "fixture failure",
    })
  })

  test("the flat event `type` is never read as a code — it is the event name `error`", () => {
    // A flat error event whose only error words are its own `type` has no code to classify.
    const verdict = inspectCodexStreamFrame({ type: "error" }, "error")
    expect(verdict).toEqual({
      kind: "server-error",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:other",
      rateLimit: null,
    })
  })

  test("the frame type is `payload.type ?? event`, as the protocol reader reads it", () => {
    // An `event: error` line around a payload of another type is that other frame: no failure,
    // exactly as `readResponseTerminal` sees it, so the hook must not strike where it does not.
    expect(inspectCodexStreamFrame({ type: "invalid_request_error" }, "error")).toBeNull()
    expect(inspectCodexStreamFrame({ type: "response.output_text.delta" }, "error")).toBeNull()
    expect(inspectCodexStreamFrame({ code: "invalid_prompt" }, "error")?.signal).toBe(
      "codex:stream-error:invalid_prompt",
    )
  })

  test.each([
    [
      "error.type usage_limit_reached, no code",
      { type: "error", error: { type: "usage_limit_reached" } },
      "codex:stream-error:usage_limit_reached",
      "rate-limited",
    ],
    [
      "response.error.type account_deactivated, no code",
      { type: "response.failed", response: { error: { type: "account_deactivated" } } },
      "codex:stream-error:account_deactivated",
      "credits-exhausted",
    ],
    [
      "error.type invalid_request_error, no code (OpenAI's catch-all type)",
      { type: "error", error: { type: "invalid_request_error", code: null, message: "bad" } },
      "codex:stream-error:other",
      "server-error",
    ],
    [
      "response.error.type invalid_request_error, no code",
      { type: "response.failed", response: { error: { type: "invalid_request_error" } } },
      "codex:stream-error:other",
      "server-error",
    ],
    [
      "an unlisted code is not overridden by a listed type (invalid_api_key)",
      { type: "error", error: { code: "invalid_api_key", type: "invalid_request_error" } },
      "codex:stream-error:other",
      "server-error",
    ],
    [
      "an unlisted code is not overridden by an account-level type either",
      { type: "error", error: { code: "something_new", type: "usage_limit_reached" } },
      "codex:stream-error:other",
      "server-error",
    ],
  ])(
    "the code decides; a nested type counts only without one, account-level only: %s",
    (_label, frame, signal, kind) => {
      const verdict = inspectCodexStreamFrame(frame, undefined)
      expect(verdict?.kind).toBe(kind)
      expect(verdict?.signal).toBe(signal)
    },
  )

  test("a payload that is not an object is no error frame, whatever the SSE event says", () => {
    for (const payload of [null, "oops", 42, ["error"]]) {
      expect(inspectCodexStreamFrame(payload, "error")).toBeNull()
    }
  })

  test("the model-unsupported HTTP rule does not run in-stream", () => {
    // The hook only acts on a closed stream-error code set; a `model is not supported when using
    // codex` body alone is not classified, so it falls to the existing server-error path.
    const verdict = inspectCodexStreamFrame(
      { type: "error", message: "The 'gpt-6' model is not supported when using codex" },
      "error",
    )
    expect(verdict).toEqual({
      kind: "server-error",
      status: 200,
      retryable: true,
      signal: "codex:stream-error:other",
      rateLimit: null,
      message: "The 'gpt-6' model is not supported when using codex",
    })
  })

  test("a `response.completed` frame is not a stream error even with a noise `code`", () => {
    const verdict = inspectCodexStreamFrame(
      { type: "response.completed", code: "invalid_prompt" },
      "response.completed",
    )
    expect(verdict).toBeNull()
  })
})
