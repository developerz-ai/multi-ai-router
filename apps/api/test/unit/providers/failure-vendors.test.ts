import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import {
  geminiBadKeyBody,
  geminiBillingBody,
  geminiOverloadBody,
  geminiRateLimitBody,
  geminiUnauthenticatedBody,
  kimiCycleLimitBody,
  kimiPermissionDeniedBody,
  kimiQuotaBody,
  kimiRateLimitBody,
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
    expect(result?.retryable).toBe(false)
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
    expect(result?.retryable).toBe(false)
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
    expect(result?.retryable).toBe(false)
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
