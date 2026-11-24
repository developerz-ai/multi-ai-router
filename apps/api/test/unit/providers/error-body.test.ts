import { describe, expect, test } from "bun:test"
import { httpDriver, readErrorFacts } from "../../../src/providers"
import { readFlatErrorFacts } from "../../../src/providers/failure/error-body"
import { response } from "./fixtures"

describe("one unreadable field costs that field alone", () => {
  test.each(["openai-api", "openai-compatible"] as const)(
    "%s: a spent balance with a null type is never a throttle",
    (provider) => {
      const body = {
        error: { message: "You exceeded it", type: null, param: null, code: "insufficient_quota" },
      }
      const result = httpDriver(provider)?.classifyFailure(response(429, { body }))

      expect(result?.kind).toBe("credits-exhausted")
      expect(result?.message).toBe("You exceeded it")
    },
  )

  test("a null or non-string message, and a structured code, keep their siblings", () => {
    expect(readErrorFacts({ error: { type: "rate_limit_error", message: null } })).toEqual({
      type: "rate_limit_error",
      code: undefined,
      message: undefined,
    })
    expect(readErrorFacts({ error: { type: { a: 1 }, message: "m", code: ["x"] } })).toEqual({
      type: undefined,
      code: undefined,
      message: "m",
    })
  })

  test("the unwrapped envelope too, which still needs its message", () => {
    expect(readFlatErrorFacts({ message: "m", type: null, code: 3505 })).toEqual({
      type: undefined,
      code: "3505",
      message: "m",
    })
    expect(readFlatErrorFacts({ type: "x", code: 1 })).toEqual({})
  })

  test("a MiniMax balance code survives a null message", () => {
    const body = { base_resp: { status_code: 1008, status_msg: null } }
    expect(httpDriver("minimax")?.classifyFailure(response(200, { body }))?.kind).toBe(
      "credits-exhausted",
    )
  })
})
