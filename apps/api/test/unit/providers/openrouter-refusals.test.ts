import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { response } from "./fixtures"

const openrouter = httpDriver("openrouter")

function classify(status: number, message: string) {
  return openrouter?.classifyFailure(
    response(status, { body: { error: { message, code: status } } }),
  )
}

const unaffordable = (limit: string) =>
  `This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 3041. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher ${limit} limit`

describe("a key cap that cannot cover the request (#441)", () => {
  test.each(["daily", "weekly", "monthly"])("a %s cap reopens on a clock", (limit) => {
    const result = classify(402, unaffordable(limit))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("openrouter:key-limit-window")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(3600)
    expect(result?.rateLimit?.resetSource).toBe("estimated")
  })

  test("a total cap, and a drained balance, stay a human's", () => {
    expect(classify(402, unaffordable("total"))?.kind).toBe("credits-exhausted")
    expect(classify(402, "Insufficient credits. Add more using …")?.kind).toBe("credits-exhausted")
  })
})

describe("no endpoint left", () => {
  test.each([
    "No endpoints found for the request with quantization: fp8,bf16. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
    "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
    "No endpoints found matching your data policy (Free model training).",
  ])("a request's own filters move it past OpenRouter, holding nothing: %s", (message) => {
    const result = classify(404, message)

    expect(result?.kind).toBe("invalid-request")
    expect(result?.providerScoped).toBe(true)
  })

  test("an id nothing serves is the model's", () => {
    const result = classify(404, "No endpoints found for inception/mercury-2.")

    expect(result?.kind).toBe("model-unsupported")
    expect(result?.providerScoped).toBeUndefined()
  })

  test("any other 404 is still the client's", () => {
    expect(classify(404, "Not found")?.providerScoped).toBeUndefined()
  })
})
