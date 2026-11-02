import { describe, expect, test } from "bun:test"
import { lookupRates } from "../../../src/services/cost"

// Independent recorded expectations: no production cards, helpers, or tier multipliers.
for (const provider of ["openai-api", "openai-oauth"] as const) {
  describe(`${provider} GPT-6 recorded rates`, () => {
    test("gpt-6-luna standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6-luna")).toEqual({
        inputPerMtok: 0.1,
        outputPerMtok: 0.5,
        cacheReadPerMtok: 0.01,
        cacheWritePerMtok: 0.125,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 0.2,
          outputPerMtok: 0.75,
          cacheReadPerMtok: 0.02,
          cacheWritePerMtok: 0.25,
        },
      })
    })

    test("gpt-6-sol standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6-sol")).toEqual({
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheReadPerMtok: 0.2,
        cacheWritePerMtok: 2.5,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 4,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.4,
          cacheWritePerMtok: 5,
        },
      })
    })

    test("gpt-6.1-sol standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6.1-sol")).toEqual({
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheReadPerMtok: 0.1,
        cacheWritePerMtok: 2.5,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 4,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.2,
          cacheWritePerMtok: 5,
        },
      })
    })

    test("gpt-6-astra standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6-astra")).toEqual({
        inputPerMtok: 10,
        outputPerMtok: 50,
        cacheReadPerMtok: 1,
        cacheWritePerMtok: 12.5,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 20,
          outputPerMtok: 75,
          cacheReadPerMtok: 2,
          cacheWritePerMtok: 25,
        },
      })
    })
  })
}
