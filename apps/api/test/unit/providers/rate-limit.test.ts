import { describe, expect, test } from "bun:test"
import { httpDriver, parseRateLimitHeaders, type RateLimitWindow } from "../../../src/providers"
import {
  EPOCH_SECONDS_CEILING_MS,
  parseEpochSeconds,
} from "../../../src/providers/rate-limit/duration"
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

function windowNamed(windows: readonly RateLimitWindow[], limiter: string): RateLimitWindow {
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

  test("explicit Retry-After overrides aggregate limiter reset without erasing window facts", () => {
    expect(signal?.resetSource).toBe("provider-reported")
    expect(signal?.resetsAt).toBeUndefined()
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

describe("an epoch-seconds reset on an x-ratelimit header", () => {
  /** The response's own clock, an hour before the reset: the plausibility check reads it. */
  const DATE = "Tue, 14 Jul 2026 02:33:20 GMT"
  const DAY = 86_400_000
  // Read as a duration, `1784000000` seconds parked the account until 2083. A value in the epoch
  // seconds range is an instant; the unit is our inference, so the label says `estimated`.
  const signal = parseRateLimitHeaders(
    response(429, {
      headers: {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1784000000",
        date: DATE,
      },
    }),
  )

  test("is read as an instant, not as fifty-six years", () => {
    const requests = windowNamed(signal?.windows ?? [], "requests")

    expect(requests.resetsAt?.getTime()).toBe(1784000000000)
    expect(requests.resetAfterSeconds).toBeUndefined()
    expect(signal?.resetsAt?.getTime()).toBe(1784000000000)
    expect(signal?.retryAfterSeconds).toBeUndefined()
  })

  test("is labeled estimated, because the unit was inferred", () => {
    expect(windowNamed(signal?.windows ?? [], "requests").resetSource).toBe("estimated")
    expect(signal?.resetSource).toBe("estimated")
  })

  test("an implausible instant is capped at a week past the response's own Date", () => {
    // `9999999999` is 2286. No limiter resets a week out; past that the number is a misread.
    const far = parseRateLimitHeaders(
      response(429, {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999", date: DATE },
      }),
    )
    const requests = windowNamed(far?.windows ?? [], "requests")

    expect(requests.resetsAt?.getTime()).toBe(Date.parse(DATE) + 7 * DAY)
    expect(requests.resetSource).toBe("estimated")
  })

  test("with no Date to check it against, an epoch-seconds value is not trusted as a reset", () => {
    const blind = parseRateLimitHeaders(
      response(429, {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
      }),
    )
    const requests = windowNamed(blind?.windows ?? [], "requests")

    expect(requests.resetsAt).toBeUndefined()
    expect(requests.resetAfterSeconds).toBeUndefined()
    expect(requests.resetSource).toBe("unknown")
  })

  test("a short duration is still a duration", () => {
    const short = parseRateLimitHeaders(response(429, { headers: { "x-ratelimit-reset": "60" } }))

    const requests = windowNamed(short?.windows ?? [], "requests")

    expect(requests.resetAfterSeconds).toBe(60)
    expect(requests.resetSource).toBe("provider-reported")
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

/**
 * Sweep 101, 04.2. `Number()` read `retry-after: 0x10` as 16 s and `1e9` as 31 years, and the breaker
 * then parked the account on our misreading. RFC 9110 `delay-seconds` is digits; anything else that
 * is not an HTTP-date is no reset at all.
 */
describe("retry-after is read strictly", () => {
  for (const value of ["0x10", "1e9", "-5", "+30", "Infinity", "30s", " 0b11 "]) {
    test(`retry-after: ${JSON.stringify(value)} states no reset`, () => {
      const signal = parseRateLimitHeaders(response(429, { headers: { "retry-after": value } }))

      expect(signal?.retryAfterSeconds).toBeUndefined()
      expect(signal?.resetsAt).toBeUndefined()
      expect(signal?.resetSource).toBe("unknown")
    })
  }

  test("retry-after-ms in exponent form is ignored, and the plain header still read", () => {
    const signal = parseRateLimitHeaders(
      response(429, { headers: { "retry-after-ms": "1e12", "retry-after": "12" } }),
    )

    expect(signal?.retryAfterSeconds).toBe(12)
  })

  test("digits and a fraction are still seconds", () => {
    for (const [value, seconds] of [
      ["30", 30],
      [" 7 ", 7],
      ["1.5", 1.5],
    ] as const) {
      const signal = parseRateLimitHeaders(response(429, { headers: { "retry-after": value } }))
      expect({ value, seconds: signal?.retryAfterSeconds }).toEqual({ value, seconds })
    }
  })
})

describe("the inferred epoch-seconds ceiling is injectable", () => {
  const reference = new Date("2026-11-10T00:00:00.000Z")

  test("defaults to a week past the response's own Date", () => {
    expect(parseEpochSeconds("9999999999", reference)?.getTime()).toBe(
      reference.getTime() + EPOCH_SECONDS_CEILING_MS,
    )
  })

  test("a tighter ceiling wins", () => {
    expect(parseEpochSeconds("9999999999", reference, 3_600_000)?.getTime()).toBe(
      reference.getTime() + 3_600_000,
    )
  })
})
