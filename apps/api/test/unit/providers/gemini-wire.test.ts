import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { geminiModelListing } from "../../../src/providers/drivers/gemini-models"
import { dailyAllowanceReset } from "../../../src/providers/drivers/gemini-quota"
import {
  geminiBadKeyBody,
  geminiBillingBody,
  geminiOverloadBody,
  geminiRateLimitBody,
  geminiUnauthenticatedBody,
  response,
} from "./fixtures"

/**
 * Gemini's compatibility surface as it answers in production: every error inside a one-element
 * array. Prod 2026-11-23/24 recorded each Gemini `429`, `503` and `400` as `http-status:…`, with no
 * upstream message and no reset.
 */

const gemini = httpDriver("gemini")

function classify(status: number, body: unknown, headers: Record<string, string> = {}) {
  const result = gemini?.classifyFailure(response(status, { body: [body], headers }))
  if (result === undefined || result === null) throw new Error("expected a failure")
  return result
}

const refusal = (message: string, status = "INVALID_ARGUMENT") => ({
  error: { code: 400, message, status },
})

describe("gemini errors arrive wrapped in an array", () => {
  test.each([
    [429, geminiRateLimitBody, "rate-limited", "gemini:RESOURCE_EXHAUSTED"],
    [400, geminiBillingBody, "credits-exhausted", "gemini:billing-stopped"],
    [401, geminiUnauthenticatedBody, "auth", "gemini:auth-status"],
    [400, geminiBadKeyBody, "auth", "gemini:api-key-invalid"],
    [503, geminiOverloadBody, "overloaded", "gemini:UNAVAILABLE"],
  ] as const)("%d is read as the object inside it", (status, body, kind, signal) => {
    const result = classify(status, body)

    expect(result.kind).toBe(kind)
    expect(result.signal).toBe(signal)
    expect(result.message).toBe(body.error.message)
  })

  test("the retry delay is read through the wrapper too", () => {
    const { rateLimit } = classify(429, geminiRateLimitBody)

    expect(rateLimit?.retryAfterSeconds).toBe(31)
    expect(rateLimit?.resetSource).toBe("provider-reported")
  })

  test("an empty or longer array is no envelope: the status decides", () => {
    for (const body of [[], [geminiRateLimitBody, geminiRateLimitBody]])
      expect(gemini?.classifyFailure(response(429, { body }))?.signal).toBe("http-status:429")
  })
})

describe("a spent gemini day", () => {
  const daily = (quotaId: string) => ({
    error: {
      code: 429,
      message: "You exceeded your current quota",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
            { quotaId },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" },
      ],
    },
  })
  const perDay = daily("GenerateRequestsPerDayPerProjectPerModel-FreeTier")

  test("waits for midnight Pacific, estimated, instead of the pacing hint", () => {
    const { rateLimit } = classify(429, perDay, { date: "Tue, 24 Nov 2026 04:00:00 GMT" })

    expect(rateLimit?.limited).toBe(true)
    expect(rateLimit?.resetsAt).toEqual(new Date("2026-11-24T08:00:00.000Z"))
    expect(rateLimit?.retryAfterSeconds).toBeUndefined()
    expect(rateLimit?.resetSource).toBe("estimated")
  })

  test("with no Date header states no reset at all, the hint included", () => {
    const { rateLimit } = classify(429, perDay)

    expect(rateLimit?.limited).toBe(true)
    expect(rateLimit?.resetsAt).toBeUndefined()
    expect(rateLimit?.retryAfterSeconds).toBeUndefined()
    expect(rateLimit?.resetSource).toBe("unknown")
  })

  test("a per-minute violation keeps the hint", () => {
    const perMinute = daily("GenerateContentInputTokensPerModelPerMinute-FreeTier")
    expect(classify(429, perMinute).rateLimit?.retryAfterSeconds).toBe(31)
  })

  test.each([
    ["summer time", "Wed, 15 Jul 2026 12:00:00 GMT", "2026-07-16T07:00:00.000Z"],
    [
      "exactly midnight names the next",
      "Tue, 24 Nov 2026 08:00:00 GMT",
      "2026-11-25T08:00:00.000Z",
    ],
    ["the day clocks go forward", "Sun, 08 Mar 2026 09:00:00 GMT", "2026-03-09T07:00:00.000Z"],
    ["the day clocks go back", "Sun, 01 Nov 2026 08:00:00 GMT", "2026-11-02T08:00:00.000Z"],
    ["a year end", "Thu, 31 Dec 2026 20:00:00 GMT", "2027-01-01T08:00:00.000Z"],
  ])("%s", (_label, date, expected) => {
    expect(dailyAllowanceReset(new Headers({ date }))).toEqual(new Date(expected))
  })

  test("an unreadable Date is no reset", () => {
    expect(dailyAllowanceReset(new Headers({ date: "soon" }))).toBeNull()
  })
})

describe("a refusal of Google's wire moves to another vendor", () => {
  test.each([
    ["Function call is missing a thought_signature in functionCall parts.", "thought-signature"],
    ["Thought signature is not valid.", "thought-signature"],
    [
      'Invalid JSON payload received. Unknown name "reasoning": Cannot find field.',
      "unknown-field",
    ],
  ])("%s", (message, rule) => {
    const result = classify(400, refusal(message))

    expect(result.kind).toBe("invalid-request")
    expect(result.providerScoped).toBe(true)
    expect(result.signal).toBe(`gemini:${rule}`)
  })

  test("any other bad request is bad everywhere, and a client's quoted words move nothing", () => {
    for (const message of [
      "Request contains an invalid argument.",
      'Model "thought_signature" is bad.',
    ]) {
      const result = classify(400, refusal(message))
      expect(result.kind).toBe("invalid-request")
      expect(result.providerScoped).toBeUndefined()
    }
  })
})

describe("gemini limits and listing", () => {
  test("a limit is the model's, not the key's", () => {
    expect(gemini?.rateLimitsPerModel?.("gemini-3.8-flash")).toBe(true)
  })

  test("the listing sends no query parameter and drops the resource prefix", () => {
    expect(gemini?.modelListing).toBe(geminiModelListing)
    expect(geminiModelListing.query()).toEqual({})
    const body = { data: [{ id: "models/gemini-3.8-flash" }, { id: "gemini-3.6-flash" }] }
    expect(geminiModelListing.read(body)?.map(({ id }) => id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.6-flash",
    ])
    expect(geminiModelListing.read({ models: [] })).toBeNull()
  })
})
