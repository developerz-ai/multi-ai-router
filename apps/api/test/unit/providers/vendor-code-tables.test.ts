import { describe, expect, test } from "bun:test"
import { httpDriver, type UpstreamFailureKind } from "../../../src/providers"
import { inspectMiniMaxSuccess } from "../../../src/providers/drivers/minimax"
import { response } from "./fixtures"

/** Refusals as each vendor's own error reference words them, read 2026-11-23. */

function classify(
  provider: "zai" | "groq" | "openai-compatible",
  status: number,
  error: Record<string, unknown>,
) {
  return httpDriver(provider)?.classifyFailure(response(status, { body: { error } }))
}

describe("z.ai, every one a 429", () => {
  test.each(["1316", "1317"])(
    "%s names a balance and is still a window, with its reset",
    (code) => {
      const result = classify("zai", 429, {
        code,
        message:
          "Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-11-24 10:00:00.",
      })

      expect(result?.kind).toBe("rate-limited")
      expect(result?.rateLimit?.resetsAt).toEqual(new Date("2026-11-24T02:00:00.000Z"))
    },
  )

  test.each<readonly [string, UpstreamFailureKind, string]>([
    ["1305", "overloaded", "The service may be temporarily overloaded, please try again later"],
    [
      "1308",
      "rate-limited",
      "Usage limit reached for 5 hour. Your limit will reset at 2026-11-24 10:00:00",
    ],
    [
      "1309",
      "credits-exhausted",
      "Your GLM Coding Plan package has expired and is temporarily unavailable.",
    ],
    [
      "1311",
      "model-unsupported",
      "Your current subscription plan does not yet include access to glm-5.2",
    ],
    ["1314", "credits-exhausted", "Your enterprise package has expired."],
    [
      "1315",
      "credits-exhausted",
      "This API Key is limited to enterprise coding package scenarios.",
    ],
    ["1113", "credits-exhausted", "Insufficient balance or no resource package. Please recharge."],
    ["1302", "rate-limited", "Rate limit reached for requests"],
  ])("%s is %s", (code, kind, message) => {
    expect(classify("zai", 429, { code, message })?.kind).toBe(kind)
  })

  test("an unknown model is the model's", () => {
    const error = { code: "1211", message: "Unknown Model, please check the model code." }
    expect(classify("zai", 400, error)?.kind).toBe("model-unsupported")
  })
})

describe("minimax, in a 200", () => {
  test.each<readonly [number, UpstreamFailureKind]>([
    [1026, "invalid-request"],
    [2053, "credits-exhausted"],
    [2056, "rate-limited"],
    [2062, "rate-limited"],
    [2049, "auth"],
    [2061, "model-unsupported"],
    [2069, "model-unsupported"],
    [2064, "overloaded"],
    [1033, "server-error"],
  ])("%d is %s", (code, kind) => {
    const verdict = inspectMiniMaxSuccess({ base_resp: { status_code: code } })
    expect(verdict?.kind).toBe(kind)
    expect(verdict?.signal).toBe(`minimax:base_resp-${code}`)
  })

  test("a code it does not publish is a server fault, under a closed signal", () => {
    expect(inspectMiniMaxSuccess({ base_resp: { status_code: 424242 } })).toMatchObject({
      kind: "server-error",
      signal: "minimax:base_resp-unknown",
    })
  })
})

describe("groq", () => {
  test("a prompt over the per-minute allowance moves to another vendor and cools nothing", () => {
    for (const code of ["rate_limit_exceeded", undefined]) {
      const result = classify("groq", 413, {
        message:
          "Request too large for model `openai/gpt-oss-120b` in organization on tokens per minute (TPM): Limit 8000, Requested 33128, please reduce your message size and try again.",
        type: "tokens",
        ...(code === undefined ? {} : { code }),
      })

      expect(result?.kind).toBe("invalid-request")
      expect(result?.providerScoped).toBe(true)
      expect(result?.rateLimit?.limited ?? false).toBe(false)
    }
  })

  test("a retired or unknown id is the model's, and a limit is too", () => {
    expect(classify("groq", 400, { code: "model_decommissioned" })?.kind).toBe("model-unsupported")
    expect(classify("groq", 404, { code: "model_not_found" })?.kind).toBe("model-unsupported")
    expect(httpDriver("groq")?.rateLimitsPerModel?.("openai/gpt-oss-120b")).toBe(true)
  })
})

describe("Alibaba Model Studio, behind its preset", () => {
  test("one model's spent free tokens hold that model, never the key", () => {
    const result = classify("openai-compatible", 403, {
      code: "AllocationQuota.FreeTierOnly",
      message: "The free tier of the model has been exhausted.",
    })
    expect(result?.kind).toBe("model-unsupported")
  })

  test("an unpaid account is a human's", () => {
    expect(classify("openai-compatible", 403, { code: "Arrearage" })?.kind).toBe(
      "credits-exhausted",
    )
  })

  test("a per-minute allocation under OpenAI's quota code is a throttle", () => {
    const result = classify("openai-compatible", 429, {
      code: "insufficient_quota",
      message: "Allocated quota exceeded, please increase your quota limit.",
    })
    expect(result?.kind).toBe("rate-limited")
  })

  test("the code alone is still a dead balance", () => {
    const error = { code: "insufficient_quota", message: "You exceeded your current quota" }
    expect(classify("openai-compatible", 429, error)?.kind).toBe("credits-exhausted")
  })
})
