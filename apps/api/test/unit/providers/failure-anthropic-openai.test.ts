import { describe, expect, test } from "bun:test"
import {
  CreditsExhaustedError,
  KeyRevokedError,
  QuotaExhaustedError,
  UpstreamAuthError,
} from "@multi-ai-router/core"
import { httpDriver, toRouterError } from "../../../src/providers"
import {
  anthropicAuthBody,
  anthropicCreditsBody,
  anthropicRateLimitBody,
  anthropicRateLimitHeaders,
  anthropicServerBody,
  openAiAuthBody,
  openAiInsufficientQuotaBody,
  openAiRateLimitBody,
  openAiRateLimitHeaders,
  openAiServerBody,
  openRouterCreditsBody,
  openRouterRateLimitBody,
  response,
} from "./fixtures"

/**
 * `cooling_down` vs `exhausted`, per provider. Both providers here can answer a dead balance
 * with a status that reads like something else — Anthropic with a `400`, OpenAI with a `429` —
 * which is exactly why classification is a driver's job and not a status-code table.
 */

const anthropic = httpDriver("anthropic-api")
const openai = httpDriver("openai-api")
const openrouter = httpDriver("openrouter")

describe("anthropic-api", () => {
  test("429 with Retry-After is a clock-recoverable rate limit", () => {
    const result = anthropic?.classifyFailure(
      response(429, { headers: anthropicRateLimitHeaders, body: anthropicRateLimitBody }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.retryable).toBe(true)
    expect(result?.rateLimit?.retryAfterSeconds).toBe(30)
    expect(result?.rateLimit?.resetsAt?.toISOString()).toBe("2026-07-24T14:32:00.000Z")
    expect(result?.rateLimit?.resetSource).toBe("provider-reported")
  })

  test("429 with no Retry-After still classifies, with no invented reset", () => {
    const result = anthropic?.classifyFailure(response(429, { body: anthropicRateLimitBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.rateLimit?.retryAfterSeconds).toBeUndefined()
    expect(result?.rateLimit?.resetsAt).toBeUndefined()
    expect(result?.rateLimit?.resetSource).toBe("unknown")
  })

  test("a 400 naming the credit balance is a hard stop, not a bad request", () => {
    const result = anthropic?.classifyFailure(response(400, { body: anthropicCreditsBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("anthropic:credit-balance-too-low")
  })

  test("401 is an auth failure, and the chain walks on to the next account's own credential", () => {
    const result = anthropic?.classifyFailure(response(401, { body: anthropicAuthBody }))

    expect(result?.kind).toBe("auth")
    // Account-scoped: this account is parked `disabled` / `needs_reauth`; the request is fine.
    expect(result?.retryable).toBe(true)
  })

  test("500 is transient and retryable on the next candidate", () => {
    const result = anthropic?.classifyFailure(response(500, { body: anthropicServerBody }))

    expect(result?.kind).toBe("server-error")
    expect(result?.retryable).toBe(true)
  })

  test("a plain success is not a failure", () => {
    expect(anthropic?.classifyFailure(response(200, { body: { type: "message" } }))).toBeNull()
  })
})

describe("openai-api", () => {
  test("429 with insufficient_quota is out of credits, NOT a rate limit", () => {
    const result = openai?.classifyFailure(
      response(429, { headers: openAiRateLimitHeaders, body: openAiInsufficientQuotaBody }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("openai:insufficient_quota")
  })

  test("429 with rate_limit_exceeded is a rate limit, with the reset it reported", () => {
    const result = openai?.classifyFailure(
      response(429, { headers: openAiRateLimitHeaders, body: openAiRateLimitBody }),
    )

    expect(result?.kind).toBe("rate-limited")
    const requests = result?.rateLimit?.windows.find((window) => window.limiter === "requests")
    expect(requests?.resetAfterSeconds).toBe(360)
    expect(requests?.resetSource).toBe("provider-reported")
  })

  test("401 with invalid_api_key is auth", () => {
    const result = openai?.classifyFailure(response(401, { body: openAiAuthBody }))

    expect(result?.kind).toBe("auth")
  })

  test("500 is transient", () => {
    expect(openai?.classifyFailure(response(500, { body: openAiServerBody }))?.kind).toBe(
      "server-error",
    )
  })

  test("an unreadable body degrades to the status, never to a wrong verdict", () => {
    const result = openai?.classifyFailure(response(429, { body: "<html>gateway timeout</html>" }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("http-status:429")
  })
})

describe("openrouter", () => {
  test("402 with an insufficient-credits body is exhausted", () => {
    const result = openrouter?.classifyFailure(response(402, { body: openRouterCreditsBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("openrouter:insufficient-credits")
  })

  test("429 is a rate limit even though the body echoes the status as a code", () => {
    const result = openrouter?.classifyFailure(response(429, { body: openRouterRateLimitBody }))

    expect(result?.kind).toBe("rate-limited")
  })
})

describe("toRouterError", () => {
  test("a rate limit becomes a 429 carrying the reported reset", () => {
    const classification = anthropic?.classifyFailure(
      response(429, { headers: anthropicRateLimitHeaders, body: anthropicRateLimitBody }),
    )
    const error = classification ? toRouterError(classification) : null

    expect(error).toBeInstanceOf(QuotaExhaustedError)
    expect((error as QuotaExhaustedError).status).toBe(429)
    expect((error as QuotaExhaustedError).retryAfterSeconds).toBe(30)
    expect((error as QuotaExhaustedError).resetsAt?.toISOString()).toBe("2026-07-24T14:32:00.000Z")
  })

  test("out of credits becomes a 402 with no retry hint at all", () => {
    const classification = openai?.classifyFailure(
      response(429, { body: openAiInsufficientQuotaBody }),
    )
    const error = classification ? toRouterError(classification) : null

    expect(error).toBeInstanceOf(CreditsExhaustedError)
    expect((error as CreditsExhaustedError).status).toBe(402)
    expect(error).not.toBeInstanceOf(QuotaExhaustedError)
  })

  test("a rejected Account credential is a 502, never the caller's 401", () => {
    const classification = anthropic?.classifyFailure(response(401, { body: anthropicAuthBody }))
    const error = classification ? toRouterError(classification) : null

    expect(error).toBeInstanceOf(UpstreamAuthError)
    expect((error as UpstreamAuthError).status).toBe(502)
    expect((error as UpstreamAuthError).code).toBe("upstream_auth_failed")
    // The router key was fine; saying 401 would send a developer after the wrong credential.
    expect(error).not.toBeInstanceOf(KeyRevokedError)
  })

  test("a 403 from the upstream is the same failure as a 401", () => {
    const classification = openrouter?.classifyFailure(
      response(403, { body: { error: { code: 403, message: "Key disabled" } } }),
    )

    expect(classification?.kind).toBe("auth")
    expect(classification ? toRouterError(classification) : null).toBeInstanceOf(UpstreamAuthError)
  })

  test("a bad request stays the upstream's own error to pass through", () => {
    const classification = openai?.classifyFailure(
      response(400, { body: { error: { message: "unknown parameter: foo", code: null } } }),
    )

    expect(classification?.kind).toBe("invalid-request")
    expect(classification ? toRouterError(classification) : "missing").toBeNull()
  })

  test("no router error body repeats the upstream's message", () => {
    const classification = openai?.classifyFailure(
      response(429, { body: openAiInsufficientQuotaBody }),
    )
    const error = classification ? toRouterError(classification) : null

    expect(error?.message).not.toContain("check your plan and billing details")
  })
})
