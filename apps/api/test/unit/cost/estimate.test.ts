import { describe, expect, test } from "bun:test"
import {
  estimateCost,
  listShippedRates,
  lookupRates,
  type RateLookup,
} from "../../../src/services/cost"
import type { TokenCounts } from "../../../src/services/usage"

/**
 * Cost estimation is a pure function over a table shipped with the image, so these tests need no
 * clock, no store, and no mock — only numbers.
 *
 * The assertions that matter are the three about *not* knowing: an unpriced model, an unpriced
 * provider, and an attempt that never selected an account all report NULL. A zero there would read
 * as "this request was free", which is the one wrong answer a spend column can give.
 */

function tokens(overrides: Partial<TokenCounts> = {}): TokenCounts {
  return { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides }
}

describe("pricing a metered attempt", () => {
  test("input and output bill at the model's published per-Mtok rates", () => {
    // Sonnet 5 at $3 / $15: 1M in and 1M out is $18 exactly.
    const cost = estimateCost(
      "anthropic-api",
      "claude-sonnet-5",
      tokens({ tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    )
    expect(cost).toEqual({ costEstimate: "18.000000", costBasis: "metered" })
  })

  test("cache reads and cache writes are their own rates, not the input rate", () => {
    // A cache read at 0.1x and a cache write at 1.25x of Opus 4.8's $5 input rate.
    const cost = estimateCost(
      "anthropic-api",
      "claude-opus-4-8",
      tokens({ cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    )
    expect(cost.costEstimate).toBe("6.750000")
    const rates = lookupRates("anthropic-api", "claude-opus-4-8")
    expect(rates?.cacheReadPerMtok).toBe(0.5)
    expect(rates?.cacheWritePerMtok).toBe(6.25)
  })

  test("a priced model with no tokens cost nothing, and that is a measurement", () => {
    // Distinct from the unknown-model case below: the rate is known, and zero tokens times a known
    // rate is genuinely zero.
    expect(estimateCost("anthropic-api", "claude-haiku-4-5", tokens())).toEqual({
      costEstimate: "0.000000",
      costBasis: "metered",
    })
  })

  test("fractions land at the column's six-decimal scale", () => {
    expect(
      estimateCost("anthropic-api", "claude-haiku-4-5", tokens({ tokensIn: 1 })).costEstimate,
    ).toBe("0.000001")
  })
})

describe("pricing a subscription attempt", () => {
  test("a Claude subscription is notional at the public API price, not metered", () => {
    const counts = tokens({ tokensIn: 1_000_000, tokensOut: 1_000_000 })
    const sub = estimateCost("anthropic-oauth", "claude-sonnet-5", counts)
    const api = estimateCost("anthropic-api", "claude-sonnet-5", counts)

    // Same number, different basis: a flat monthly fee has no per-request charge, so the figure is
    // an attribution. The two totals are reported separately and never summed.
    expect(sub.costEstimate).toBe(api.costEstimate)
    expect(sub.costBasis).toBe("notional")
    expect(api.costBasis).toBe("metered")
  })
})

describe("what the table does not know", () => {
  test("an unpriced model is null and unknown, never zero", () => {
    expect(
      estimateCost("anthropic-api", "claude-not-a-model", tokens({ tokensIn: 5_000 })),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("a provider that bills its own model ids ships no prices at all", () => {
    // z.ai, Kimi, MiniMax, OpenRouter and the `*-compatible` escape hatches: unknown by design, not
    // by omission — a price shipped for them would be invented.
    for (const provider of ["zai", "kimi", "minimax", "openrouter", "openai-compatible"] as const) {
      expect(estimateCost(provider, "glm-4.7", tokens({ tokensIn: 5_000 }))).toEqual({
        costEstimate: null,
        costBasis: "unknown",
      })
    }
  })

  test("an attempt that never selected an account has no provider to price against", () => {
    expect(estimateCost(null, "claude-sonnet-5", tokens({ tokensIn: 5_000 }))).toEqual({
      costEstimate: null,
      costBasis: "unknown",
    })
  })

  test("a subscription on an unpriced model reports unknown, not a notional nothing", () => {
    // `notional` claims we valued the row. Without a rate there is nothing to value it at.
    expect(
      estimateCost("anthropic-oauth", "claude-not-a-model", tokens({ tokensIn: 5_000 })),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("a count no column can hold reports unknown rather than failing the insert", () => {
    // `numeric(14, 6)` tops out under $100M. An upstream reporting a nonsense token count must not
    // take down the batch every other record is written in.
    expect(estimateCost("anthropic-api", "claude-fable-5", tokens({ tokensOut: 1e15 }))).toEqual({
      costEstimate: null,
      costBasis: "unknown",
    })
  })
})

describe("listing the shipped table", () => {
  // The settings screen renders these rows beside the operator's overrides, which is only possible
  // because the table can be enumerated at all — it used to be probeable one key at a time.
  test("every row agrees with the single-model lookup", () => {
    const rows = listShippedRates()

    expect(rows.length).toBeGreaterThan(0)
    for (const { provider, model, ...rates } of rows) {
      expect(lookupRates(provider, model)).toEqual(rates)
    }
  })

  test("both anthropic surfaces are listed, priced identically and separately", () => {
    const providers = new Set(listShippedRates().map((row) => row.provider))

    // A subscription is valued at what the same tokens cost on the API, so it carries the same
    // rows — and an operator overriding one must be able to see it is not overriding the other.
    expect(providers).toEqual(new Set(["anthropic-oauth", "anthropic-api"]))
  })

  test("the order is stable across calls and groups a provider's models together", () => {
    // A list read against an operator's own edits must not reshuffle between renders.
    const first = listShippedRates().map((row) => `${row.provider}/${row.model}`)
    const second = listShippedRates().map((row) => `${row.provider}/${row.model}`)
    expect(first).toEqual(second)

    // One contiguous run per provider, so a screen renders one heading each without re-sorting.
    const providers = listShippedRates().map((row) => row.provider)
    const runs = providers.filter((id, i) => id !== providers[i - 1]).length
    expect(runs).toBe(new Set(providers).size)
  })
})

describe("an injected price lookup", () => {
  // The operator's override book is one of these, and `estimateCost` must not be able to tell.
  const flat: RateLookup = () => ({
    inputPerMtok: 100,
    outputPerMtok: 200,
    cacheReadPerMtok: 0,
    cacheWritePerMtok: 0,
  })

  test("wins over the shipped table for a model the shipped table also prices", () => {
    const counts = tokens({ tokensIn: 1_000_000, tokensOut: 1_000_000 })
    expect(estimateCost("anthropic-api", "claude-sonnet-5", counts, flat)).toEqual({
      costEstimate: "300.000000",
      costBasis: "metered",
    })
    // The shipped table itself is untouched — an override layers over it, it does not replace it.
    expect(lookupRates("anthropic-api", "claude-sonnet-5")?.inputPerMtok).toBe(3)
  })

  test("prices a provider the shipped table has no list for at all", () => {
    // z.ai bills its own model ids, so only an operator can say what one costs.
    expect(estimateCost("zai", "glm-4.7", tokens({ tokensIn: 1_000_000 }), flat)).toEqual({
      costEstimate: "100.000000",
      costBasis: "metered",
    })
  })

  test("is genuinely consulted: a lookup that knows nothing reports unknown", () => {
    // Proves the injection replaces the table rather than merging with it. If the shipped rate
    // leaked through here, an override that removed a price would silently keep charging.
    expect(
      estimateCost("anthropic-api", "claude-sonnet-5", tokens({ tokensIn: 1 }), () => null),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("omitting it prices exactly as passing the shipped table does", () => {
    const counts = tokens({ tokensIn: 4_000, cacheReadTokens: 9_000 })
    for (const model of ["claude-opus-4-8", "claude-not-a-model"]) {
      expect(estimateCost("anthropic-api", model, counts)).toEqual(
        estimateCost("anthropic-api", model, counts, lookupRates),
      )
    }
  })
})

describe("model name matching", () => {
  test("a dated snapshot prices as its family", () => {
    const snapshot = estimateCost(
      "anthropic-api",
      "claude-haiku-4-5-20251001",
      tokens({ tokensIn: 1_000_000 }),
    )
    expect(snapshot).toEqual({ costEstimate: "1.000000", costBasis: "metered" })
  })

  test("casing and stray whitespace do not lose a price", () => {
    expect(lookupRates("anthropic-api", "  Claude-Sonnet-5 ")?.inputPerMtok).toBe(3)
  })
})
