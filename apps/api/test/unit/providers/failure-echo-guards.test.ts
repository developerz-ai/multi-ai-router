import { describe, expect, test } from "bun:test"
import type { ProviderId } from "@multi-ai-router/core"
import { httpDriver } from "../../../src/providers"
import { wordingOf } from "../../../src/providers/failure/classify"
import { kimiQuotaBody, response } from "./fixtures"

/**
 * Sweep 101, 04.1 + 10.1. Upstream `4xx` messages echo client-chosen text — a model name, a block
 * `type` — and wording rules that read any status turned that echo into a dead balance: one request
 * parked a healthy account `exhausted`, and the chain offered it to the next account and parked that
 * too. Every echo body below is a failure case first; the genuine bodies after them still classify.
 */

function classify(provider: ProviderId, status: number, body: unknown) {
  const driver = httpDriver(provider)
  if (driver === null) throw new Error(`${provider} is not an HTTP driver`)
  return driver.classifyFailure(response(status, { body }))
}

const anthropicError = (type: string, message: string) => ({
  type: "error",
  error: { type, message },
})
const openAiError = (message: string, extra: Record<string, string> = {}) => ({
  error: { message, ...extra },
})

/**
 * Prod, developerz-ai, 2026-11-09 19:04Z..11-10 12:38Z (kimi account `80dfa451`, redacted): five
 * `upstream attempt failed status=429 failureKind=credits-exhausted
 * signal=kimi:exceeded_current_quota_error`, five parks at `exhausted`, 28 client `402`s — while the
 * account's own `seven_day` plan window read `utilization=1.000, resets_at=2026-11-12 14:31`.
 */
const kimiWeekly429 = anthropicError(
  "exceeded_current_quota_error",
  "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription",
)

describe("10.1 — Kimi's weekly window on a 429 is a cooldown, never a dead balance", () => {
  test("the prod body: rate-limited, carrying the long-window re-test as an estimate", () => {
    const result = classify("kimi", 429, kimiWeekly429)

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("kimi:usage-limit-weekly")
    expect(result?.retryable).toBe(true)
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(60 * 60)
  })

  test("the 5-hour phrasing under the same type is a cooldown too", () => {
    const result = classify(
      "kimi",
      429,
      anthropicError(
        "exceeded_current_quota_error",
        "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
      ),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("kimi:usage-limit-5-hour")
  })

  test("the type still means a drained balance when no window sentence is present", () => {
    const result = classify("kimi", 429, kimiQuotaBody)

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("kimi:exceeded_current_quota_error")
  })
})

describe("04.1 — an echoed name is never a verdict", () => {
  test("anthropic-api: 404 `model: credit balance is too low` is not a dead balance", () => {
    const result = classify(
      "anthropic-api",
      404,
      anthropicError("not_found_error", "model: credit balance is too low"),
    )

    expect(result?.kind).not.toBe("credits-exhausted")
    expect(result?.kind).toBe("invalid-request")
  })

  test("anthropic-api: a 400 quoting the phrase as a block tag is not a dead balance", () => {
    const result = classify(
      "anthropic-api",
      400,
      anthropicError(
        "invalid_request_error",
        "Input tag 'credit balance is too low' found using 'type' does not match any of the expected tags",
      ),
    )

    expect(result?.kind).toBe("invalid-request")
  })

  test("anthropic-api: the genuine spent balance still parks the key", () => {
    const result = classify(
      "anthropic-api",
      400,
      anthropicError(
        "invalid_request_error",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      ),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("anthropic:credit-balance-too-low")
  })

  test("kimi: a 403 model refusal ending in balance words stays auth", () => {
    const result = classify(
      "kimi",
      403,
      anthropicError("permission_error", "You do not have access to model insufficient balance"),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.signal).toBe("kimi:model-access-denied")
  })

  test("kimi: a 403 model refusal ending in limit words is not a spent window", () => {
    const result = classify(
      "kimi",
      403,
      anthropicError(
        "permission_error",
        "You do not have access to model reached your usage limit. Quota will reset",
      ),
    )

    expect(result?.kind).toBe("auth")
  })

  test("kimi: a 404 echoing limit words is a bad request, never a cooldown", () => {
    const result = classify(
      "kimi",
      404,
      anthropicError("not_found_error", "model reached your usage limit not found"),
    )

    expect(result?.kind).toBe("invalid-request")
    expect(result?.rateLimit?.resetSource).not.toBe("estimated")
  })

  for (const provider of ["groq", "xai", "openai-compatible", "anthropic-compatible"] as const) {
    test(`${provider}: 404 model-not-found echoing balance words is not a dead balance`, () => {
      for (const message of [
        "The model `insufficient balance` does not exist or you do not have access to it.",
        "The model insufficient balance does not exist",
      ]) {
        const result = classify(provider, 404, openAiError(message, { code: "model_not_found" }))
        expect({ message, kind: result?.kind }).toEqual({ message, kind: "invalid-request" })
      }
    })

    test(`${provider}: a 400 whose code names a missing model is not a dead balance`, () => {
      const result = classify(
        provider,
        400,
        openAiError("model insufficient credits not found", { code: "model_not_found" }),
      )

      expect(result?.kind).not.toBe("credits-exhausted")
    })

    test(`${provider}: genuine balance wording on a 400 still parks the account`, () => {
      const result = classify(provider, 400, openAiError("Insufficient balance on this account"))

      expect(result?.kind).toBe("credits-exhausted")
    })
  }

  for (const provider of ["deepseek", "zai"] as const) {
    test(`${provider}: a 400 quoting the model name is not a dead balance`, () => {
      const result = classify(
        provider,
        400,
        openAiError("Model 'insufficient balance' does not exist", {
          type: "invalid_request_error",
        }),
      )

      expect(result?.kind).toBe("invalid-request")
    })
  }

  test("deepseek: an unquoted echo is not anchored at the start, so it is no verdict", () => {
    const result = classify("deepseek", 400, openAiError("Model Not Exist: insufficient balance"))

    expect(result?.kind).toBe("invalid-request")
  })

  test("deepseek: the published 402 still names its signal", () => {
    const result = classify("deepseek", 402, openAiError("Insufficient Balance"))

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("deepseek:insufficient-balance")
  })

  test("zai: a bare 'account balance' description is not a drained balance", () => {
    const result = classify(
      "zai",
      400,
      openAiError("Invalid parameter. Please check your account balance page for plan details."),
    )

    expect(result?.kind).toBe("invalid-request")
  })

  test("opencode-go: a 400 echoing the overload tag is not the backend being busy", () => {
    const result = classify("opencode-go", 400, openAiError("Model is unavailable: [overloaded]"))

    expect(result?.kind).toBe("model-unsupported")
  })
})

describe("10.7 — an opencode-go team key the plan does not cover needs a human, not a re-probe", () => {
  for (const message of [
    "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models.",
    "This API key belongs to the team workspace. Use a personal API key to call Go models.",
  ]) {
    test(message.slice(0, 40), () => {
      const result = classify("opencode-go", 403, openAiError(message))

      expect(result?.kind).toBe("credits-exhausted")
      expect(result?.signal).toBe("opencode-go:plan-not-entitled")
    })
  }

  test("any other Go 403 stays a rejected credential", () => {
    expect(classify("opencode-go", 403, openAiError("Invalid API key"))?.kind).toBe("auth")
  })
})

describe("10.16 — a model OpenRouter delisted fails over and strikes nothing", () => {
  test("404 `is no longer available` is model-unsupported", () => {
    const result = classify(
      "openrouter",
      404,
      openAiError("inception/mercury-2 is no longer available on OpenRouter", { code: "404" }),
    )

    expect(result?.kind).toBe("model-unsupported")
    expect(result?.retryable).toBe(true)
  })

  test("a 400 echo of credit words is never OpenRouter's spent balance", () => {
    const result = classify(
      "openrouter",
      400,
      openAiError("vendor/requires more credits is not a valid model ID", { code: "400" }),
    )

    expect(result?.kind).toBe("model-unsupported")
  })
})

describe("04.8 — status defaults", () => {
  test("408 and 425 are transient: the next account gets its turn", () => {
    for (const status of [408, 425]) {
      const result = classify("openai-compatible", status, undefined)
      expect({ status, kind: result?.kind, retryable: result?.retryable }).toEqual({
        status,
        kind: "server-error",
        retryable: true,
      })
    }
  })

  test("a bare 529 is overloaded, whatever happened to its body", () => {
    expect(classify("anthropic-api", 529, "<html>bad gateway</html>")?.kind).toBe("overloaded")
  })

  test("OpenRouter's 408 needs no rule of its own", () => {
    const result = classify("openrouter", 408, undefined)

    expect(result?.kind).toBe("server-error")
    expect(result?.signal).toBe("http-status:408")
  })
})

describe("04.4 — wording rules read a bounded message", () => {
  test("a 64 KB adversarial Kimi body classifies in single-digit milliseconds", () => {
    const flood = anthropicError("invalid_request_error", "account ".repeat(8192))
    classify("kimi", 400, flood)
    const started = performance.now()
    const result = classify("kimi", 400, flood)
    const elapsed = performance.now() - started

    expect(result?.kind).toBe("invalid-request")
    expect(elapsed).toBeLessThan(20)
  })

  test("the classification still carries the upstream's whole message", () => {
    const message = `${"x".repeat(5000)} insufficient balance`
    const result = classify("groq", 400, openAiError(message))

    expect(result?.message).toBe(message)
    expect(result?.kind).toBe("invalid-request")
  })
})

describe("wordingOf", () => {
  test("strips quoted and backticked spans, keeps apostrophes", () => {
    expect(wordingOf("You've reached the 'x' limit")).toBe("You've reached the   limit")
    expect(wordingOf('model "a b" `c` “d” ‘e’ end')).toBe("model         end")
    expect(wordingOf("it’s the users' quota")).toBe("it’s the users' quota")
  })

  test("caps the text a rule reads", () => {
    expect(wordingOf("a".repeat(10_000))?.length).toBe(2048)
    expect(wordingOf(undefined)).toBeUndefined()
  })
})
