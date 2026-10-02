import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import {
  geminiBadKeyBody,
  geminiBillingBody,
  geminiOverloadBody,
  geminiRateLimitBody,
  geminiUnauthenticatedBody,
  kimiCycleLimitBody,
  kimiFiveHourLimitBody,
  kimiPermissionDeniedBody,
  kimiQuotaBody,
  kimiRateLimitBody,
  kimiWeeklyLimitBody,
  miniMaxBalanceBody,
  miniMaxSuccessBody,
  miniMaxThrottleBody,
  response,
  zaiBalanceBody,
  zaiThrottleBody,
  zaiWindowExhaustedBody,
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
const groq = httpDriver("groq")
const deepseek = httpDriver("deepseek")
const xai = httpDriver("xai")
const mistral = httpDriver("mistral")
const together = httpDriver("together")
const cerebras = httpDriver("cerebras")

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

  /**
   * A spent plan window, as the live endpoint reports it: `1310`, no headers at all, and the reset
   * stated once inside the message. Reading it is what keeps a *weekly* window from being re-probed
   * on the breaker's five-minute backoff for the four days it has left to run.
   */
  test("1310 is a cooldown the plan's own clock lifts, not a drained balance", () => {
    const result = zai?.classifyFailure(response(429, { body: zaiWindowExhaustedBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("zai:window-exhausted")
    expect(result?.retryable).toBe(true)
  })

  test("the reset buried in the 1310 message is read as UTC+8 and reported, not estimated", () => {
    const result = zai?.classifyFailure(response(429, { body: zaiWindowExhaustedBody }))

    // 2026-08-01 10:03:40 in Asia/Shanghai is 02:03:40Z.
    expect(result?.rateLimit?.resetsAt?.toISOString()).toBe("2026-08-01T02:03:40.000Z")
    expect(result?.rateLimit?.resetSource).toBe("provider-reported")
    expect(result?.rateLimit?.limited).toBe(true)
    expect(result?.rateLimit?.windows.map((window) => window.limiter)).toContain("weekly-monthly")
  })

  test("a throttle carrying no reset still reads its headers, and invents nothing", () => {
    const result = zai?.classifyFailure(
      response(429, { headers: { "retry-after": "30" }, body: zaiThrottleBody }),
    )

    expect(result?.rateLimit?.retryAfterSeconds).toBe(30)
    expect(result?.rateLimit?.windows).toHaveLength(0)
  })
})

describe("kimi", () => {
  test("exceeded_current_quota_error on a 429 is credits, not a cooldown", () => {
    const result = kimi?.classifyFailure(response(429, { body: kimiQuotaBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("kimi:exceeded_current_quota_error")
  })

  /**
   * The live shape of a spent plan, and the one that used to be silently destructive: a 403 falls
   * to the status default `auth`, and an `api-key` account's auth failure parks at `disabled`
   * (`routing/breaker.ts`) — permanently, for a cycle Kimi itself refills.
   */
  test("a spent billing cycle is a cooldown, though Kimi announces it as a 403", () => {
    const result = kimi?.classifyFailure(response(403, { body: kimiCycleLimitBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("kimi:billing-cycle-limit")
    expect(result?.retryable).toBe(true)
  })

  test("the other permission_error is still a real auth failure", () => {
    const result = kimi?.classifyFailure(response(403, { body: kimiPermissionDeniedBody }))

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("http-status:403")
  })

  /**
   * The body that parked `kimi` in production on 2026-10-02 at 02:18Z: the 5-hour window, worded
   * "reset" rather than the billing cycle's "refreshed". It matched no rule, fell to `403 -> auth`,
   * and the account sat out of rotation until a human pressed a button — for a window Kimi itself
   * reopens five hours later.
   */
  test("a spent 5-hour window is a cooldown with an estimated reset, not an auth failure", () => {
    const result = kimi?.classifyFailure(response(403, { body: kimiFiveHourLimitBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.retryable).toBe(true)
    expect(result?.signal).toBe("kimi:usage-limit-5-hour")
    // Kimi names no instant ("when the current 5-hour window ends") and sends no headers, so the
    // reset is ours, and labeled as ours: a guess presented as the provider's word is worse than none.
    expect(result?.rateLimit?.limited).toBe(true)
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(15 * 60)
    expect(result?.rateLimit?.resetsAt).toBeUndefined()
  })

  test("a spent weekly window is a cooldown with a longer estimated reset", () => {
    const result = kimi?.classifyFailure(response(403, { body: kimiWeeklyLimitBody }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("kimi:usage-limit-weekly")
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(60 * 60)
  })

  test("a spent billing cycle carries an estimated reset too, so the breaker does not hammer it", () => {
    const result = kimi?.classifyFailure(response(403, { body: kimiCycleLimitBody }))

    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(60 * 60)
  })

  test("a reported Retry-After outranks the estimate — the provider's word is the truth", () => {
    const result = kimi?.classifyFailure(
      response(403, { headers: { "retry-after": "120" }, body: kimiFiveHourLimitBody }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(120)
    expect(result?.rateLimit?.resetSource).not.toBe("estimated")
  })

  test("a genuine permission_error carries no invented reset", () => {
    const result = kimi?.classifyFailure(response(403, { body: kimiPermissionDeniedBody }))
    expect(result?.rateLimit).toBeNull()
  })

  /**
   * The wording family, one line per phrasing. Kimi has reordered these words at least three times;
   * the next reordering should fail exactly one row here rather than park an account in production.
   */
  test.each([
    [
      "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
    ],
    [
      "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.",
    ],
    [
      "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
    ],
    // A curly apostrophe, as a copy-edited body may carry: nothing may hinge on "You've".
    ["You\u2019ve reached your 5-hour usage limit."],
    // A window Kimi has not shipped yet, worded the way all three of its siblings are.
    ["You've reached your daily usage limit."],
    ["Your quota will reset when the current window ends."],
  ])("%s is a cooldown, not an auth failure", (message) => {
    const result = kimi?.classifyFailure(
      response(403, { body: { type: "error", error: { type: "permission_error", message } } }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds ?? 0).toBeGreaterThan(0)
  })

  test("a body that only describes a limit, without reaching it, stays an auth failure", () => {
    const message =
      "Your usage limit is 1000 requests per day. You do not have access to model k3-preview"
    const result = kimi?.classifyFailure(
      response(403, { body: { type: "error", error: { type: "permission_error", message } } }),
    )

    expect(result?.kind).toBe("auth")
  })

  /**
   * A limit wording that *also* says the account was taken away. The limit clause alone would read
   * as a window that reopens on a clock; the rest says no clock will, and that a human has to look.
   * Review of #139: the family regex had no guard, so this classified `rate-limited`.
   */
  test.each([
    [
      "Your account has reached its usage limit and has been suspended for violating terms of service.",
    ],
    ["You've reached your weekly (7-day) usage limit. Your account has been suspended."],
    ["You've reached your 5-hour usage limit. This account is banned."],
    ["You've reached your usage limit for this billing cycle. Your account has been disabled."],
    ["Usage limit reached: your account was deactivated for a terms of service violation."],
    // Round 2 of the review. A breach of terms beside the suspension outranks any clock.
    [
      "Your account has been temporarily suspended for violating our terms of service until your usage limit resets.",
    ],
    // A clock with no limit clause, and a limit clause with no clock: neither is a spent window.
    ["Your account has been temporarily suspended."],
    ["Your account has been suspended. Your quota will reset in the next cycle."],
    ["You've reached your usage limit. Your account has been suspended until further notice."],
  ])("%s stays an auth failure — a suspension needs a human", (message) => {
    const result = kimi?.classifyFailure(
      response(403, { body: { type: "error", error: { type: "permission_error", message } } }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("kimi:account-suspended")
    expect(result?.rateLimit).toBeNull()
  })

  /**
   * Review of #139, round 2: the guard above read every "suspended", "disabled" or "terms of
   * service" as an account taken away, and so flipped a real spent window back to `auth` whenever
   * Kimi worded the *pause* that way. A limit that was reached and a clock that reopens it is a
   * window, however the pause between them is named; boilerplate about terms is not a verdict.
   */
  test.each([
    [
      "Your API access has been temporarily suspended until your 5-hour usage limit resets.",
      "kimi:usage-limit-5-hour",
      15 * 60,
    ],
    [
      "You've reached your 5-hour usage limit. Requests are temporarily suspended until the window ends.",
      "kimi:usage-limit-5-hour",
      15 * 60,
    ],
    [
      "Your account is temporarily disabled because you have reached your weekly usage limit.",
      "kimi:usage-limit-weekly",
      60 * 60,
    ],
    [
      "You've reached your weekly (7-day) usage limit. Usage is subject to our Terms of Service.",
      "kimi:usage-limit-weekly",
      60 * 60,
    ],
    [
      "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. Usage is subject to our Terms of Service.",
      "kimi:usage-limit-5-hour",
      15 * 60,
    ],
    // Both at once: the pause named "suspended", and the boilerplate in the sentence after it.
    [
      "You've reached your 5-hour usage limit. Requests are temporarily suspended until the window ends. Usage is subject to our Terms of Service.",
      "kimi:usage-limit-5-hour",
      15 * 60,
    ],
    [
      "Your access is suspended until your weekly (7-day) usage limit resets.",
      "kimi:usage-limit-weekly",
      60 * 60,
    ],
    ["Requests are suspended until your usage limit resets.", "kimi:usage-limit", 15 * 60],
  ])("%s is a spent window, not a suspension", (message, signal, retryAfterSeconds) => {
    const result = kimi?.classifyFailure(
      response(403, { body: { type: "error", error: { type: "permission_error", message } } }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe(signal)
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(retryAfterSeconds)
  })

  test("a body that only describes when a limit resets, without a pause, stays an auth failure", () => {
    const message =
      "Your 5-hour usage limit resets every five hours. You do not have access to model k3-preview"
    const result = kimi?.classifyFailure(
      response(403, { body: { type: "error", error: { type: "permission_error", message } } }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("http-status:403")
  })

  /**
   * The suspension wording is a guard on Kimi's `403` limit bodies, not a new reading of every
   * status: a throttle or an overload that happens to say "suspended" / "terminated" / "violation"
   * keeps its own kind, or a transient fault would park an api-key account as needing a human.
   */
  test.each([
    [
      429,
      "rate_limit_reached_error",
      "Requests temporarily suspended: rate limit violation.",
      "rate-limited",
    ],
    [
      503,
      "engine_overloaded_error",
      "Stream terminated: the engine is overloaded.",
      "server-error",
    ],
    [500, "server_error", "Upstream connection terminated.", "server-error"],
  ] as const)(
    "a %d whose message says suspended/terminated keeps its own kind",
    (status, type, message, kind) => {
      const result = kimi?.classifyFailure(
        response(status, { body: { type: "error", error: { type, message } } }),
      )

      expect(result?.kind).toBe(kind)
      expect(result?.signal).not.toBe("kimi:account-suspended")
    },
  )

  /** The reversed order of the same fact: the limit first, `reached` after it. */
  test.each([
    ["Usage limit reached. Try again later.", "kimi:usage-limit", 15 * 60],
    ["Your usage limit has been reached.", "kimi:usage-limit", 15 * 60],
    ["Your 5-hour usage limit has been reached.", "kimi:usage-limit-5-hour", 15 * 60],
    ["Your weekly (7-day) usage limit has been reached.", "kimi:usage-limit-weekly", 60 * 60],
  ])("%s is a cooldown too", (message, signal, retryAfterSeconds) => {
    const result = kimi?.classifyFailure(
      response(403, { body: { type: "error", error: { type: "permission_error", message } } }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe(signal)
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(retryAfterSeconds)
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
    // The credential's problem stays the account's: parked, and the next candidate takes the turn.
    expect(result?.retryable).toBe(true)
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

/**
 * The six OpenAI-shaped vendors. They share a dialect and differ only in how each words a failure,
 * which is the whole reason each is a pinned id rather than an `openai-compatible` account. Only the
 * fields a driver actually keys on are corroborated below; the surrounding ones are filled the way
 * the vendor's own captures fill them.
 */

/** A real completion, for the "a success is never a failure" half of each vendor's coverage. */
const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
}

describe("groq", () => {
  test("a spend limit arrives as a 400 and is still a dead balance", () => {
    const result = groq?.classifyFailure(
      response(400, {
        body: {
          error: {
            message: "Organization has been blocked from making API requests.",
            type: "invalid_request_error",
            code: "blocked_api_access",
          },
        },
      }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("groq:blocked_api_access")
    expect(result?.retryable).toBe(true)
  })

  test("`type` names the limit that was hit, so no rule here reads it", () => {
    // `type: "tokens"` is Groq's *dimension*, not an error kind. A typeRule would classify it as an
    // unknown vocabulary and fall through; the code is what carries the meaning.
    const result = groq?.classifyFailure(
      response(429, {
        body: {
          error: {
            message:
              "Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 15000, Used 11972, Requested 4351.",
            type: "tokens",
            code: "rate_limit_exceeded",
          },
        },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("groq:rate_limit_exceeded")
  })

  test("flex-tier capacity is transient, though 498 is a 4xx", () => {
    const result = groq?.classifyFailure(response(498, { body: "Flex Tier Capacity Exceeded" }))

    expect(result?.kind).toBe("server-error")
    expect(result?.signal).toBe("groq:flex-tier-capacity")
    expect(result?.retryable).toBe(true)
  })

  test("a rejected key is this account's own problem", () => {
    const result = groq?.classifyFailure(
      response(401, {
        body: { error: { message: "Invalid API Key", code: "invalid_api_key" } },
      }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.retryable).toBe(true)
  })
})

describe("deepseek", () => {
  const balanceBody = {
    error: {
      message: "Insufficient Balance",
      type: "unknown_error",
      param: null,
      code: "invalid_request_error",
    },
  }

  test("402 Insufficient Balance is a dead balance, and the signal names why", () => {
    const result = deepseek?.classifyFailure(response(402, { body: balanceBody }))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("deepseek:insufficient-balance")
  })

  test("nothing reads DeepSeek's inverted code — a rejected key is still auth", () => {
    // `code` here says `invalid_request_error`, which is what OpenAI would put in `type`. A codeRule
    // would read this as a client mistake and never flag the credential.
    const result = deepseek?.classifyFailure(
      response(401, {
        body: {
          error: {
            message: "Authentication Fails (no such user)",
            type: "authentication_error",
            param: null,
            code: "invalid_request_error",
          },
        },
      }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.retryable).toBe(true)
  })

  test("429 is a cooldown and 503 is transient — DeepSeek's statuses mean what they say", () => {
    expect(deepseek?.classifyFailure(response(429))?.kind).toBe("rate-limited")
    expect(deepseek?.classifyFailure(response(503))?.kind).toBe("server-error")
  })
})

describe("xai", () => {
  test("a 429 is a cooldown, and outranks the wording backstop below it", () => {
    // The trap this ordering exists for: a throttle message that names a quota. Read by wording
    // alone it is a dead balance, and no clock revives a `402`.
    const result = xai?.classifyFailure(
      response(429, {
        body: { error: { message: "Request quota exceeded for grok-4, please slow down." } },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("vendor:http-429")
  })

  test("a 402 is a dead balance on the status alone — xAI publishes no code for one", () => {
    const result = xai?.classifyFailure(
      response(402, { body: { error: { message: "no credits" } } }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("http-status:402")
  })

  test("the flat Responses-shape error still yields a readable message", () => {
    const result = xai?.classifyFailure(
      response(400, {
        body: {
          code: "Client specified an invalid argument",
          error: "Argument not supported on this model: stop",
        },
      }),
    )

    expect(result?.kind).toBe("invalid-request")
    expect(result?.message).toBe("Argument not supported on this model: stop")
  })
})

describe("mistral", () => {
  test("the unwrapped envelope is read at all — there is no `error` key to find", () => {
    const result = mistral?.classifyFailure(
      response(401, {
        body: {
          object: "error",
          message: "Unauthorized",
          type: "authentication_error",
          param: null,
          code: null,
        },
      }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("mistral:authentication_error")
  })

  test("service-tier capacity is a cooldown, matched on the message its codes contradict", () => {
    const result = mistral?.classifyFailure(
      response(429, {
        body: {
          object: "error",
          message: "Service tier capacity exceeded for this model.",
          type: "service_tier_capacity_exceeded",
          param: null,
          code: "3505",
        },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("mistral:service-tier-capacity")
  })

  test("a rate_limit_error relayed under a status of its own is still a cooldown", () => {
    const result = mistral?.classifyFailure(
      response(500, {
        body: {
          object: "error",
          message: "Requests rate limit exceeded",
          type: "rate_limit_error",
        },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("mistral:rate_limit_error")
  })

  test("a completion is not a failure — the looser reader must not find one in a 200", () => {
    expect(mistral?.classifyFailure(response(200, { body: COMPLETION }))).toBeNull()
  })
})

describe("together", () => {
  test("403 is an oversized prompt, not a rejected credential", () => {
    // Together's own error table: 403 means input tokens + max_tokens exceeded the context length.
    // Left to the default it would be `auth`, which flags the key and pulls the account.
    const result = together?.classifyFailure(
      response(403, {
        body: {
          error: {
            message:
              "Input token count + max_tokens parameter must be less than the context length of the model being queried.",
            type: "invalid_request_error",
          },
        },
      }),
    )

    expect(result?.kind).toBe("invalid-request")
    expect(result?.signal).toBe("together:context-length-403")
    expect(result?.retryable).toBe(false)
  })

  test("429 names which dynamic limit was hit", () => {
    const result = together?.classifyFailure(
      response(429, {
        body: {
          error: { message: "You have been rate limited.", type: "dynamic_token_limited" },
        },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("together:dynamic-rate-limited")
  })

  test("503 is the platform's capacity, never this account's budget", () => {
    const result = together?.classifyFailure(
      response(503, { body: { error: { message: "Model is overloaded", type: "overloaded" } } }),
    )

    expect(result?.kind).toBe("server-error")
    expect(result?.retryable).toBe(true)
  })

  test("402 is the monthly spending cap, and no clock lifts one", () => {
    const result = together?.classifyFailure(
      response(402, {
        body: {
          error: {
            message:
              "The account associated with the API key has reached its maximum allowed monthly spending limit.",
          },
        },
      }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.retryable).toBe(true)
  })
})

describe("cerebras", () => {
  test("the unwrapped envelope carries `wrong_api_key`, and that is an auth failure", () => {
    const result = cerebras?.classifyFailure(
      response(401, {
        body: {
          message: "Wrong API Key",
          type: "invalid_request_error",
          param: "api_key",
          code: "wrong_api_key",
        },
      }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("cerebras:wrong_api_key")
    expect(result?.retryable).toBe(true)
  })

  test("a spent daily token allowance is a 429, so it cools down rather than exhausting", () => {
    const result = cerebras?.classifyFailure(
      response(429, {
        body: { message: "Total tokens per day limit exceeded", type: "too_many_requests_error" },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("vendor:http-429")
    expect(result?.retryable).toBe(true)
  })

  test("402 is the one refusal a human has to clear", () => {
    expect(cerebras?.classifyFailure(response(402))?.kind).toBe("credits-exhausted")
  })

  test("a completion is not a failure", () => {
    expect(cerebras?.classifyFailure(response(200, { body: COMPLETION }))).toBeNull()
  })
})

describe("ollama", () => {
  const ollama = httpDriver("ollama")

  test("a model the node has not pulled is named, and is still the client's problem", () => {
    // The verdict is what a 404 already means; the signal is what makes it readable. Retrying this
    // onto another account would be the router deciding which node should serve a model — the
    // Account's declared model set is where that belongs.
    const result = ollama?.classifyFailure(
      response(404, {
        body: { error: { message: 'model "llama3.2" not found, try pulling it first' } },
      }),
    )

    expect(result?.kind).toBe("invalid-request")
    expect(result?.signal).toBe("ollama:model-not-pulled")
    expect(result?.retryable).toBe(false)
  })

  test("the same words in a completion are not a failure", () => {
    expect(
      ollama?.classifyFailure(
        response(200, { body: { error: { message: "not found, try pulling it first" } } }),
      ),
    ).toBeNull()
  })

  test("a hosted surface's hourly limit cools down — never a dead balance", () => {
    const result = ollama?.classifyFailure(
      response(429, { body: { error: { message: "You have exceeded your hourly quota" } } }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("vendor:http-429")
    expect(result?.retryable).toBe(true)
  })

  test("out-of-credits wording on an error status still reaches a human", () => {
    const result = ollama?.classifyFailure(
      response(402, { body: { error: { message: "insufficient credits" } } }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("compatible:out-of-credits-wording")
  })

  test("a model that will not load is the node's problem, and the next account gets a turn", () => {
    const result = ollama?.classifyFailure(
      response(500, {
        body: { error: { message: "model requires more system memory than is available" } },
      }),
    )

    expect(result?.kind).toBe("server-error")
    expect(result?.retryable).toBe(true)
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
