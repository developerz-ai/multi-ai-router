import { describe, expect, test } from "bun:test"
import { ProviderPreferences } from "../../src"

/**
 * An OpenRouter account's `provider` routing preferences, validated once at the admin write. The
 * shape is OpenRouter's own request field (openrouter.ai/docs/features/provider-routing, read
 * 2026-11-14), so a stored value is sent as-is. Invalid input is refused, never trimmed to fit.
 */

describe("ProviderPreferences, refusals first", () => {
  test.each([
    ["an unknown sort", { sort: "cheapest" }],
    ["an unknown quantization", { quantizations: ["fp7"] }],
    ["an empty quantization list", { quantizations: [] }],
    ["a duplicated quantization", { quantizations: ["fp8", "fp8"] }],
    ["a non-boolean allow_fallbacks", { allow_fallbacks: "yes" }],
    ["an empty provider slug", { order: [""] }],
    ["a field OpenRouter does not have", { prefer: "fast" }],
    ["a camelCase spelling of a real field", { allowFallbacks: true }],
    ["an empty object, which states nothing", {}],
  ])("refuses %s", (_name, value) => {
    expect(ProviderPreferences.safeParse(value).success).toBe(false)
  })

  test("accepts the coding account's preferences exactly as written", () => {
    const value = { sort: "price", quantizations: ["fp8", "bf16"], allow_fallbacks: true }
    expect<unknown>(ProviderPreferences.parse(value)).toEqual(value)
  })

  test("accepts every documented field together", () => {
    const value = {
      sort: "throughput",
      quantizations: ["fp8"],
      allow_fallbacks: false,
      order: ["deepinfra", "novita"],
      only: ["deepinfra"],
      ignore: ["chutes"],
      require_parameters: true,
    }
    expect<unknown>(ProviderPreferences.parse(value)).toEqual(value)
  })
})
