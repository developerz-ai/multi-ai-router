import { describe, expect, test } from "bun:test"
import {
  ApiError,
  errorMessage,
  isConflict,
  OFFLINE_MESSAGE,
  parseErrorBody,
  toApiError,
} from "../../src/lib/api/errors"

// The rule under test: **the operator sees the server's sentence, never a bare
// status.** A 409 from a delete names the keys it would narrow, and that text is
// the whole value of the response.

describe("parseErrorBody", () => {
  test("reads the OpenAI shape the admin plane renders", () => {
    const parsed = parseErrorBody({
      error: {
        message: 'pool "claude-subs" is named by the scope of 2 key(s)',
        type: "invalid_request_error",
        param: null,
        code: "pool_in_use",
      },
    })

    expect(parsed).toEqual({
      message: 'pool "claude-subs" is named by the scope of 2 key(s)',
      type: "invalid_request_error",
      code: "pool_in_use",
    })
  })

  test("reads the Anthropic shape, which carries no code", () => {
    const parsed = parseErrorBody({
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    })

    expect(parsed).toEqual({ message: "slow down", type: "rate_limit_error", code: null })
  })

  test("returns null for anything without a usable message", () => {
    for (const body of [
      null,
      undefined,
      42,
      "boom",
      {},
      { error: {} },
      { error: { message: "" } },
    ]) {
      expect(parseErrorBody(body)).toBeNull()
    }
  })
})

describe("toApiError", () => {
  test("keeps the server's own message and code", () => {
    const error = toApiError(409, {
      error: {
        message: "Re-scope them first.",
        type: "invalid_request_error",
        code: "pool_in_use",
      },
    })

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(409)
    expect(error.message).toBe("Re-scope them first.")
    expect(error.code).toBe("pool_in_use")
    expect(isConflict(error)).toBe(true)
  })

  test("falls back to a sentence, never to a bare status", () => {
    const error = toApiError(404, undefined)

    expect(error.message).toBe("That no longer exists.")
    expect(error.message).not.toMatch(/^\d+$/)
  })

  test("an unmapped status still reads as a sentence", () => {
    expect(toApiError(418, null).message).toBe("The router answered 418.")
  })
})

describe("errorMessage", () => {
  test("a network failure is named as one rather than shown as a stack", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe(OFFLINE_MESSAGE)
  })

  test("an unknown throw never leaks its shape into the UI", () => {
    expect(errorMessage({ secret: "value" })).toBe("Something went wrong.")
  })

  test("an ApiError renders its message", () => {
    expect(errorMessage(toApiError(400, { error: { message: "bad label" } }))).toBe("bad label")
  })
})
