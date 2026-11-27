import { describe, expect, test } from "bun:test"
import { estimateCost, type RateLookup } from "../../../src/services/cost"
import type { TokenCounts } from "../../../src/services/usage"

/**
 * A cost the upstream reports (OpenRouter's `usage.cost`) prices an attempt no rate can. Pure: the
 * figure arrives as an input, read off the response by the observer.
 */

const TOKENS: TokenCounts = {
  tokensIn: 1_000_000,
  tokensOut: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}
const NEMOTRON = "nvidia/nemotron-3-ultra-550b-a55b"
const openrouter = (fields: { reportedCost?: number | null; prices?: RateLookup } = {}) =>
  estimateCost({ provider: "openrouter", model: NEMOTRON, tokens: TOKENS, ...fields })

describe("no figure, no number", () => {
  test("nothing reported stays unknown, as before", () => {
    expect(openrouter()).toEqual({ costEstimate: null, costBasis: "unknown" })
    expect(openrouter({ reportedCost: null })).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("a figure the column cannot hold is unknown, never a failed insert", () => {
    for (const reportedCost of [-1, Number.NaN, Number.POSITIVE_INFINITY, 100_000_000])
      expect(openrouter({ reportedCost }).costBasis).toBe("unknown")
  })

  test("no provider is unknown whatever was reported", () => {
    expect(
      estimateCost({ provider: null, model: NEMOTRON, tokens: TOKENS, reportedCost: 1 }).costBasis,
    ).toBe("unknown")
  })
})

describe("the reported figure is booked as it stands", () => {
  test("metered, at the column's scale, marked reported", () => {
    expect(openrouter({ reportedCost: 1.2345678 })).toEqual({
      costEstimate: "1.234568",
      costBasis: "metered",
      source: "reported",
    })
  })

  test("a reported zero is a measured zero", () => {
    expect(openrouter({ reportedCost: 0 })).toMatchObject({
      costEstimate: "0.000000",
      costBasis: "metered",
    })
  })

  test("a subscription-billed account keeps its basis: an attribution, not spend", () => {
    expect(
      estimateCost({
        provider: "openrouter",
        model: NEMOTRON,
        tokens: TOKENS,
        billing: "subscription",
        reportedCost: 0.5,
      }),
    ).toMatchObject({ costEstimate: "0.500000", costBasis: "notional", source: "reported" })
  })

  test("an operator override for the model wins over the reported figure", () => {
    const override: RateLookup = () => ({
      inputPerMtok: 2,
      outputPerMtok: 10,
      cacheReadPerMtok: 2,
      cacheWritePerMtok: 0,
    })
    expect(openrouter({ reportedCost: 0.5, prices: override })).toEqual({
      costEstimate: "3.000000",
      costBasis: "metered",
    })
  })
})
