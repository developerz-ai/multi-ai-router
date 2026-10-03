import { expect, test } from "bun:test"
import { openAiCompatibleDriver } from "../../../src/providers/drivers/openai-compatible"
import { openRouterDriver } from "../../../src/providers/drivers/openrouter"
import { parseDurationSeconds } from "../../../src/providers/rate-limit/duration"
import { parseRateLimitHeaders } from "../../../src/providers/rate-limit/parse"

const response = (status: number, headers: Record<string, string> = {}, body?: unknown) => ({
  status,
  headers: new Headers(headers),
  body,
})
test("depleted six-minute duration reaches aggregate; unrelated shorter reset ignored", () => {
  const signal = parseRateLimitHeaders(
    response(429, {
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "6m0s",
      "x-ratelimit-remaining-requests": "9",
      "x-ratelimit-reset-requests": "1s",
    }),
  )
  expect(signal?.retryAfterSeconds).toBe(360)
  expect(signal?.resetSource).toBe("provider-reported")
})
test("multiple depleted durations use latest; explicit retry takes precedence", () => {
  const headers = {
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-reset-tokens": "6m",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": "10m",
  }
  expect(parseRateLimitHeaders(response(429, headers))?.retryAfterSeconds).toBe(600)
  expect(
    parseRateLimitHeaders(response(429, { ...headers, "retry-after": "0.25" }))?.retryAfterSeconds,
  ).toBe(0.25)
})
test("blank negative zero malformed retry does not fabricate instant or erase fallback", () => {
  for (const value of ["", " ", "-1", "0", "not-a-date"]) {
    const s = parseRateLimitHeaders(response(429, { "retry-after": value }))
    expect(s?.retryAfterSeconds).toBeUndefined()
    expect(s?.resetSource).toBe("unknown")
  }
  expect(parseRateLimitHeaders(response(429, { "retry-after-ms": "250" }))?.retryAfterSeconds).toBe(
    0.25,
  )
  expect(parseDurationSeconds("garbage6m")).toBeNull()
  expect(parseDurationSeconds("-6m")).toBeNull()
})
test("OpenRouter sanitized moderation403 is caller fault and408 transient", () => {
  expect(
    openRouterDriver.classifyFailure(
      response(403, {}, { error: { code: 403, message: "Your input was flagged by moderation" } }),
    )?.kind,
  ).toBe("invalid-request")
  expect(openRouterDriver.classifyFailure(response(408))?.retryable).toBe(true)
  expect(openRouterDriver.classifyFailure(response(401))?.kind).toBe("auth")
})
test("compatible exact body uses bounded response Date year; balance stays permanent", () => {
  const body = {
    error: {
      message: "1-month quota has been exhausted. The quota will reset at 10-13 16:00:00 UTC.",
    },
  }
  const failure = openAiCompatibleDriver.classifyFailure(
    response(429, { date: "Fri, 02 Oct 2026 23:00:00 GMT" }, body),
  )
  expect(failure?.kind).toBe("rate-limited")
  expect(failure?.rateLimit?.resetsAt?.toISOString()).toBe("2026-10-13T16:00:00.000Z")
  expect(
    openAiCompatibleDriver.classifyFailure(response(429, {}, body))?.rateLimit?.resetsAt,
  ).toBeUndefined()
  expect(
    openAiCompatibleDriver.classifyFailure(
      response(429, {}, { error: { message: "insufficient balance" } }),
    )?.kind,
  ).toBe("credits-exhausted")
})

test("duration fixture produces real health cooldown at six minutes", async () => {
  const { createHealthStore } = await import("../../../src/services/dataplane/health")
  const now = new Date("2026-10-03T12:00:00Z")
  const s = parseRateLimitHeaders(
    response(429, { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "6m0s" }),
  )
  const health = createHealthStore()
  health.applyRateLimit("a", s, now)
  expect(health.stateOf("a").breaker.cooldownUntil).toEqual(new Date(now.getTime() + 360000))
})

test("body reset refuses absent year reference, invalid calendar and distant ambiguous year", () => {
  for (const stamp of ["02-30 16:00:00", "01-01 16:00:00", "12-30 16:00:00"]) {
    const body = { error: { message: `quota exhausted. The quota will reset at ${stamp} UTC.` } }
    expect(
      openAiCompatibleDriver.classifyFailure(
        response(429, { date: "Fri, 02 Oct 2026 23:00:00 GMT" }, body),
      )?.rateLimit?.resetsAt,
    ).toBeUndefined()
  }
  expect(
    parseRateLimitHeaders(
      response(429, { "retry-after": "Sat, 03 Oct 2026 12:01:00 GMT" }),
    )?.resetsAt?.toISOString(),
  ).toBe("2026-10-03T12:01:00.000Z")
  expect(parseRateLimitHeaders(response(200))).toBeNull()
})

test("moderation is a sanitized caller400 without auth/billing strike;408 remains transient", async () => {
  const { toRouterError } = await import("../../../src/providers/failure/router-error")
  const { createHealthStore } = await import("../../../src/services/dataplane/health")
  const { failoverKind } = await import("../../../src/services/dataplane/attempt")
  const moderation = openRouterDriver.classifyFailure(
    response(403, {}, { error: { code: 403, message: "Your input was flagged by moderation" } }),
  )
  if (moderation === null) throw new Error("missing fixture classification")
  expect(toRouterError(moderation)?.status).toBe(400)
  const health = createHealthStore()
  health.recordFailure(
    "a",
    { kind: failoverKind(moderation.kind, 403), message: "fixture" },
    new Date(),
  )
  expect(health.stateOf("a").breaker.status).toBe("active")
  expect(health.stateOf("a").breaker.consecutiveFailures).toBe(0)
  expect(
    openRouterDriver.classifyFailure(
      response(402, {}, { error: { message: "insufficient credits" } }),
    )?.kind,
  ).toBe("credits-exhausted")
})

test("strict duration grammar and blank remaining do not invent depleted constraints", () => {
  for (const value of ["6m junk", "6m-1s", "1e3", "Infinity", "-1", ""])
    expect(parseDurationSeconds(value)).toBeNull()
  expect(parseDurationSeconds("0.25s")).toBe(0.25)
  expect(parseDurationSeconds("20ms")).toBe(0.02)
  expect(
    parseRateLimitHeaders(
      response(200, {
        "x-ratelimit-limit-tokens": "10",
        "x-ratelimit-remaining-tokens": "",
        "x-ratelimit-reset-tokens": "6m",
      }),
    )?.limited,
  ).toBe(false)
})

test("compatible annual rollover uses response Date and works for both supported envelopes", async () => {
  const { anthropicCompatibleDriver } = await import(
    "../../../src/providers/drivers/anthropic-compatible"
  )
  for (const driver of [openAiCompatibleDriver, anthropicCompatibleDriver]) {
    const failure = driver.classifyFailure(
      response(
        429,
        { date: "Thu, 31 Dec 2026 23:00:00 GMT" },
        { error: { message: "quota exhausted. The quota will reset at 01-01 16:00:00 UTC." } },
      ),
    )
    expect(failure?.rateLimit?.resetsAt?.toISOString()).toBe("2027-01-01T16:00:00.000Z")
    expect(failure?.kind).toBe("rate-limited")
    expect(
      driver.classifyFailure(response(402, {}, { error: { message: "insufficient balance" } }))
        ?.kind,
    ).toBe("credits-exhausted")
  }
})

test("router429 deadline matches conservative absolute-plus-relative cooldown", async () => {
  const { toRouterError } = await import("../../../src/providers/failure/router-error")
  const { QuotaExhaustedError } = await import("@multi-ai-router/core")
  const now = new Date("2026-10-03T12:00:00Z")
  const classification = openRouterDriver.classifyFailure(response(429))
  if (classification === null) throw new Error("missing fixture")
  const error = toRouterError(
    {
      ...classification,
      rateLimit: {
        limited: true,
        windows: [],
        resetSource: "provider-reported",
        resetsAt: new Date(now.getTime() + 10000),
        retryAfterSeconds: 300,
      },
    },
    { signal: null, now },
  )
  expect(error).toBeInstanceOf(QuotaExhaustedError)
  if (!(error instanceof QuotaExhaustedError)) throw new Error("wrong fixture error")
  expect(error.retryAfterSeconds).toBe(300)
  expect(error.resetsAt).toEqual(new Date(now.getTime() + 300000))
  const unknown = toRouterError(classification, {
    signal: null,
    now,
    unknownResetRetryAfterSeconds: 17,
  })
  if (!(unknown instanceof QuotaExhaustedError)) throw new Error("wrong fixture error")
  expect(unknown.retryAfterSeconds).toBe(17)
  expect(unknown.resetsAt).toBeUndefined()
  const fallback = toRouterError(classification)
  if (!(fallback instanceof QuotaExhaustedError)) throw new Error("wrong fixture error")
  expect(fallback.retryAfterSeconds).toBe(30)
  expect(fallback.resetsAt).toBeUndefined()
})
