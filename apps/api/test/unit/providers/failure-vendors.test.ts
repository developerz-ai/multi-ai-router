import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import {
  geminiBadKeyBody,
  geminiBillingBody,
  geminiOverloadBody,
  geminiRateLimitBody,
  geminiUnauthenticatedBody,
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
const gemini = httpDriver("gemini")

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

/**
 * Gemini is the one vendor here that words a failure as a canonical gRPC status rather than an
 * error code, and the one whose *throttle* message names billing. Reading either wrong costs the
 * account: the first classifies everything on the HTTP status, the second parks a healthy key at
 * `402` where no clock will revive it.
 */
describe("gemini", () => {
  test("RESOURCE_EXHAUSTED is a cooldown, even though its message names billing", () => {
    const result = gemini?.classifyFailure(response(429, { body: geminiRateLimitBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("gemini:RESOURCE_EXHAUSTED")
    expect(result?.retryable).toBe(true)
  })

  test("a billing stop is permanent, and arrives as a 400 rather than a 402", () => {
    const result = gemini?.classifyFailure(response(400, { body: geminiBillingBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("gemini:billing-stopped")
  })

  test("UNAUTHENTICATED is the credential's problem", () => {
    const result = gemini?.classifyFailure(response(401, { body: geminiUnauthenticatedBody }))

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("gemini:auth-status")
    expect(result?.retryable).toBe(false)
  })

  test("a rejected key dressed as a client mistake is still an auth failure", () => {
    const result = gemini?.classifyFailure(response(400, { body: geminiBadKeyBody }))

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("gemini:api-key-invalid")
  })

  test("an overloaded model is transient", () => {
    expect(gemini?.classifyFailure(response(503, { body: geminiOverloadBody }))?.kind).toBe(
      "server-error",
    )
  })

  test("an OpenAI-shaped body from the compatibility layer still reads", () => {
    const result = gemini?.classifyFailure(
      response(400, { body: { error: { message: "Unsupported value", type: "invalid_request" } } }),
    )

    expect(result?.kind).toBe("invalid-request")
    expect(result?.signal).toBe("http-status:400")
  })

  test("a successful completion is not a failure, whatever words it contains", () => {
    const body = {
      choices: [{ message: { content: "To use Vertex you must enable billing on the project." } }],
    }

    expect(gemini?.classifyFailure(response(200, { body }))).toBeNull()
  })

  test("the retry delay comes out of the body: Gemini sends no rate-limit headers", () => {
    const result = gemini?.classifyFailure(response(429, { body: geminiRateLimitBody }))

    expect(result?.rateLimit?.limited).toBe(true)
    expect(result?.rateLimit?.retryAfterSeconds).toBe(31)
    expect(result?.rateLimit?.resetSource).toBe("provider-reported")
  })

  test("a 429 with no RetryInfo reports an unknown reset rather than a guess", () => {
    const result = gemini?.classifyFailure(
      response(429, { body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } } }),
    )

    expect(result?.rateLimit?.limited).toBe(true)
    expect(result?.rateLimit?.retryAfterSeconds).toBeUndefined()
    expect(result?.rateLimit?.resetSource).toBe("unknown")
  })

  test("RetryInfo on a service failure is not read as this credential's window", () => {
    const body = {
      error: {
        code: 503,
        status: "UNAVAILABLE",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "8s" }],
      },
    }

    expect(gemini?.classifyFailure(response(503, { body }))?.rateLimit).toBeNull()
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
