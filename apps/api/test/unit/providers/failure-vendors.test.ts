import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import {
  kimiQuotaBody,
  kimiRateLimitBody,
  miniMaxBalanceBody,
  miniMaxSuccessBody,
  miniMaxThrottleBody,
  response,
  zaiBalanceBody,
  zaiThrottleBody,
} from "./fixtures"

/**
 * The prepaid-balance vendors. Each words a dead balance differently, and that wording is the
 * whole reason these drivers exist as more than a base URL: getting it wrong leaves an account
 * that no clock can revive being retried on a timer.
 */

const zai = httpDriver("zai")
const kimi = httpDriver("kimi")
const minimax = httpDriver("minimax")

describe("zai", () => {
  test("code 1113 is a drained balance, whatever the status says", () => {
    const result = zai?.classifyFailure(response(400, { body: zaiBalanceBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("zai:balance-code")
  })

  test("the 130x family is throttling", () => {
    const result = zai?.classifyFailure(response(429, { body: zaiThrottleBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.retryable).toBe(true)
  })

  test("an unrecognized code falls back to the status", () => {
    const result = zai?.classifyFailure(
      response(401, { body: { error: { code: "9999", message: "unknown" } } }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("http-status:401")
  })

  test("wording catches a drained balance a code change would hide", () => {
    const result = zai?.classifyFailure(
      response(400, { body: { error: { message: "insufficient balance" } } }),
    )

    expect(result?.signal).toBe("zai:insufficient-balance")
  })
})

describe("kimi", () => {
  test("exceeded_current_quota_error on a 429 is credits, not a cooldown", () => {
    const result = kimi?.classifyFailure(response(429, { body: kimiQuotaBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("kimi:exceeded_current_quota_error")
  })

  test("rate_limit_reached_error is a cooldown", () => {
    expect(kimi?.classifyFailure(response(429, { body: kimiRateLimitBody }))?.kind).toBe(
      "rate-limited",
    )
  })

  test("500 is transient", () => {
    expect(kimi?.classifyFailure(response(500))?.kind).toBe("server-error")
  })
})

describe("minimax", () => {
  test("a dead balance reported inside a 200 is still a dead balance", () => {
    const result = minimax?.classifyFailure(response(200, { body: miniMaxBalanceBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.status).toBe(200)
    expect(result?.signal).toBe("minimax:base_resp-1008")
  })

  test("base_resp throttling is a cooldown", () => {
    expect(minimax?.classifyFailure(response(200, { body: miniMaxThrottleBody }))?.kind).toBe(
      "rate-limited",
    )
  })

  test("a base_resp success is not a failure", () => {
    expect(minimax?.classifyFailure(response(200, { body: miniMaxSuccessBody }))).toBeNull()
  })

  test("it still reads ordinary Anthropic-shaped errors", () => {
    const result = minimax?.classifyFailure(
      response(401, { body: { type: "error", error: { type: "authentication_error" } } }),
    )

    expect(result?.kind).toBe("auth")
  })
})

describe("the generic escape hatches", () => {
  const compatible = httpDriver("openai-compatible")

  test("a widely shared out-of-credits phrasing on an error status is credits", () => {
    const result = compatible?.classifyFailure(
      response(403, { body: { error: { message: "Insufficient credits for this request" } } }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("compatible:out-of-credits-wording")
  })

  test("the same phrasing inside a successful completion is not a failure", () => {
    const result = compatible?.classifyFailure(
      response(200, { body: { error: { message: "insufficient credits" } } }),
    )

    expect(result).toBeNull()
  })

  test("it guesses nothing else: an unknown vendor's 400 stays an invalid request", () => {
    const result = compatible?.classifyFailure(
      response(400, { body: { error: { message: "model not found" } } }),
    )

    expect(result?.kind).toBe("invalid-request")
    expect(result?.retryable).toBe(false)
  })
})
