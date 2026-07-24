import { describe, expect, test } from "bun:test"
import { httpDriver, parseRateLimitHeaders } from "../../../src/providers"
import {
  anthropicRateLimitHeaders,
  openAiRateLimitHeaders,
  openRouterRateLimitHeaders,
  response,
} from "./fixtures"

/**
 * Quota signals, normalized. Two properties matter as much as the numbers: a reset is labeled
 * with where it came from, and the driver never invents one — an unreported reset is `unknown`,
 * which is what makes the UI's "unknown — will retry with backoff" honest.
 */

function windowNamed(windows: readonly { limiter: string }[], limiter: string) {
  const found = windows.find((window) => window.limiter === limiter)
  if (!found) throw new Error(`no window for ${limiter}`)
  return found
}

describe("Anthropic rate-limit headers", () => {
  const signal = httpDriver("anthropic-api")?.parseRateLimit(
    response(429, { headers: anthropicRateLimitHeaders }),
  )

  test("reads every limiter the response reported", () => {
    expect(signal?.windows.map((window) => window.limiter)).toEqual(["input-tokens", "requests"])
  })

  test("derives a continuous utilization from limit and remaining", () => {
    const requests = windowNamed(signal?.windows ?? [], "requests")
    const tokens = windowNamed(signal?.windows ?? [], "input-tokens")

    expect(requests.utilization).toBe(1)
    expect(requests.utilizationSource).toBe("continuous")
    expect(tokens.utilization).toBeCloseTo(0.75, 5)
  })

  test("labels the reported reset as provider-reported and takes the earliest", () => {
    expect(signal?.resetSource).toBe("provider-reported")
    expect(signal?.resetsAt?.toISOString()).toBe("2026-07-24T14:32:00.000Z")
    expect(windowNamed(signal?.windows ?? [], "requests").resetSource).toBe("provider-reported")
  })

  test("carries Retry-After and the limited flag", () => {
    expect(signal?.retryAfterSeconds).toBe(30)
    expect(signal?.limited).toBe(true)
  })
})

describe("OpenAI rate-limit headers", () => {
  const signal = httpDriver("openai-api")?.parseRateLimit(
    response(429, { headers: openAiRateLimitHeaders }),
  )

  test("parses the duration reset form into seconds, not an instant", () => {
    const requests = windowNamed(signal?.windows ?? [], "requests")

    expect(requests.resetAfterSeconds).toBe(360)
    expect(requests.resetsAt).toBeUndefined()
    expect(requests.resetSource).toBe("provider-reported")
  })

  test("handles sub-second units", () => {
    expect(windowNamed(signal?.windows ?? [], "tokens").resetAfterSeconds).toBeCloseTo(0.02, 5)
  })

  test("a spent limiter marks the signal limited even without a 429", () => {
    const quiet = parseRateLimitHeaders(response(200, { headers: openAiRateLimitHeaders }))

    expect(quiet?.limited).toBe(true)
  })
})

describe("OpenRouter's unsuffixed budget headers", () => {
  const signal = httpDriver("openrouter")?.parseRateLimit(
    response(429, { headers: openRouterRateLimitHeaders }),
  )

  test("reads epoch milliseconds as an absolute reset on the requests limiter", () => {
    const requests = windowNamed(signal?.windows ?? [], "requests")

    expect(requests.resetsAt?.getTime()).toBe(1784000000000)
    expect(requests.remaining).toBe(0)
    expect(requests.utilization).toBe(1)
  })
})

describe("what a driver refuses to invent", () => {
  test("a 429 with no headers is still a signal, but with an unknown reset", () => {
    const signal = parseRateLimitHeaders(response(429))

    expect(signal).toEqual({ limited: true, resetSource: "unknown", windows: [] })
  })

  test("a quiet success reports nothing at all", () => {
    expect(parseRateLimitHeaders(response(200))).toBeNull()
  })

  test("an HTTP-date Retry-After becomes an instant, never a guessed duration", () => {
    const signal = parseRateLimitHeaders(
      response(429, { headers: { "retry-after": "Fri, 24 Jul 2026 14:32:00 GMT" } }),
    )

    expect(signal?.retryAfterSeconds).toBeUndefined()
    expect(signal?.resetsAt?.toISOString()).toBe("2026-07-24T14:32:00.000Z")
    expect(signal?.resetSource).toBe("provider-reported")
  })

  test("a limiter with no limit reports no utilization and says why", () => {
    const signal = parseRateLimitHeaders(
      response(200, { headers: { "x-ratelimit-reset-requests": "1s" } }),
    )
    const requests = windowNamed(signal?.windows ?? [], "requests")

    expect(requests.utilization).toBeUndefined()
    expect(requests.utilizationSource).toBe("none")
  })

  test("retry-after-ms is honored where a provider sends it", () => {
    const signal = parseRateLimitHeaders(response(429, { headers: { "retry-after-ms": "1500" } }))

    expect(signal?.retryAfterSeconds).toBe(1.5)
  })
})
