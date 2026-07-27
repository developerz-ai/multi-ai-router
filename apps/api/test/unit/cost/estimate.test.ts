import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import {
  estimateCost,
  listShippedRates,
  lookupRates,
  PRICE_TABLE_AS_OF,
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
 *
 * The second group is about **which** basis a priced attempt reports under, which is a fact about
 * the Account and not about the provider: the same z.ai key serves a metered API and a flat-fee
 * coding plan, and only the operator can say which was bought.
 */

function tokens(overrides: Partial<TokenCounts> = {}): TokenCounts {
  return { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides }
}

describe("pricing a metered attempt", () => {
  test("input and output bill at the model's published per-Mtok rates", () => {
    // Sonnet 5 at $3 / $15: 1M in and 1M out is $18 exactly.
    const cost = estimateCost({
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      tokens: tokens({ tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    })
    expect(cost).toEqual({ costEstimate: "18.000000", costBasis: "metered" })
  })

  test("cache reads and cache writes are their own rates, not the input rate", () => {
    // A cache read at 0.1x and a cache write at 1.25x of Opus 4.8's $5 input rate.
    const cost = estimateCost({
      provider: "anthropic-api",
      model: "claude-opus-4-8",
      tokens: tokens({ cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    })
    expect(cost.costEstimate).toBe("6.750000")
    const rates = lookupRates("anthropic-api", "claude-opus-4-8")
    expect(rates?.cacheReadPerMtok).toBe(0.5)
    expect(rates?.cacheWritePerMtok).toBe(6.25)
  })

  test("a priced model with no tokens cost nothing, and that is a measurement", () => {
    // Distinct from the unknown-model case below: the rate is known, and zero tokens times a known
    // rate is genuinely zero.
    expect(
      estimateCost({ provider: "anthropic-api", model: "claude-haiku-4-5", tokens: tokens() }),
    ).toEqual({ costEstimate: "0.000000", costBasis: "metered" })
  })

  test("a model a vendor publishes at zero is metered zero, not unknown", () => {
    // z.ai's Flash line is free on the international platform. That is a price, so it reports as
    // one — the single case where a zero in a spend column is the truth rather than a stand-in.
    expect(
      estimateCost({
        provider: "zai",
        model: "glm-4.7-flash",
        tokens: tokens({ tokensIn: 1_000_000, tokensOut: 1_000_000 }),
      }),
    ).toEqual({ costEstimate: "0.000000", costBasis: "metered" })
  })

  test("fractions land at the column's six-decimal scale", () => {
    expect(
      estimateCost({
        provider: "anthropic-api",
        model: "claude-haiku-4-5",
        tokens: tokens({ tokensIn: 1 }),
      }).costEstimate,
    ).toBe("0.000001")
  })
})

describe("pricing the nine providers that used to report nothing", () => {
  // Every one of these was `unknown` for every request until this table shipped, which for a
  // deployment routing OpenAI traffic meant no cost visibility at all on its largest provider.
  const PRICED: ReadonlyArray<readonly [ProviderId, string]> = [
    ["openai-api", "gpt-5.6-sol"],
    ["openai-oauth", "gpt-5.6-sol"],
    ["gemini", "gemini-2.5-flash"],
    ["zai", "glm-4.7"],
    ["kimi", "kimi-k3"],
    ["minimax", "minimax-m2.7"],
    ["groq", "llama-3.3-70b-versatile"],
    ["deepseek", "deepseek-v4-pro"],
    ["xai", "grok-4.5"],
    ["mistral", "mistral-large-latest"],
    ["together", "moonshotai/kimi-k3"],
    ["cerebras", "gpt-oss-120b"],
  ]

  for (const [provider, model] of PRICED) {
    test(`${provider} prices ${model} rather than reporting unknown`, () => {
      const cost = estimateCost({ provider, model, tokens: tokens({ tokensIn: 1_000_000 }) })

      expect(cost.costBasis).not.toBe("unknown")
      expect(cost.costEstimate).not.toBeNull()
      // A rate of zero for a model nobody publishes as free would be a table gap wearing a number.
      expect(Number(cost.costEstimate)).toBeGreaterThan(0)
    })
  }
})

describe("which basis a priced attempt reports under", () => {
  const counts = tokens({ tokensIn: 1_000_000, tokensOut: 1_000_000 })

  test("a subscription account is notional at the public API price, not metered", () => {
    const sub = estimateCost({
      provider: "anthropic-oauth",
      model: "claude-sonnet-5",
      tokens: counts,
      billing: "subscription",
    })
    const api = estimateCost({
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      tokens: counts,
    })

    // Same number, different basis: a flat monthly fee has no per-request charge, so the figure is
    // an attribution. The two totals are reported separately and never summed.
    expect(sub.costEstimate).toBe(api.costEstimate)
    expect(sub.costBasis).toBe("notional")
    expect(api.costBasis).toBe("metered")
  })

  test("a coding-plan account on a metered provider is notional too", () => {
    // The decision this replaced a hardcoded provider set to make. z.ai, Kimi and MiniMax each sell
    // a flat-fee plan behind the same endpoint and key shape as their metered API; nothing on the
    // wire tells them apart, so the operator's answer on the Account is the only one there is.
    const plan = estimateCost({
      provider: "zai",
      model: "glm-4.7",
      tokens: counts,
      billing: "subscription",
    })
    const metered = estimateCost({ provider: "zai", model: "glm-4.7", tokens: counts })

    expect(plan.costEstimate).toBe(metered.costEstimate)
    expect(plan.costBasis).toBe("notional")
    expect(metered.costBasis).toBe("metered")
  })

  test("saying nothing prices as metered, which is what an unstated account row holds", () => {
    expect(estimateCost({ provider: "kimi", model: "kimi-k3", tokens: counts }).costBasis).toBe(
      "metered",
    )
    expect(
      estimateCost({ provider: "kimi", model: "kimi-k3", tokens: counts, billing: "metered" })
        .costBasis,
    ).toBe("metered")
  })

  test("the basis is the account's, never the provider's — the same provider answers both ways", () => {
    // The bug this closed: a two-element provider set decided this, so every account of a provider
    // shared one answer and a coding plan was indistinguishable from a metered key.
    const pairs = [
      ["zai", "glm-4.7"],
      ["kimi", "kimi-k3"],
      ["minimax", "minimax-m2.7"],
      ["openai-api", "gpt-5.6-sol"],
    ] as const

    for (const [provider, model] of pairs) {
      const metered = estimateCost({ provider, model, tokens: counts, billing: "metered" })
      const sub = estimateCost({ provider, model, tokens: counts, billing: "subscription" })

      expect(metered.costBasis).toBe("metered")
      expect(sub.costBasis).toBe("notional")
      expect(sub.costEstimate).toBe(metered.costEstimate)
    }
  })

  test("a subscription on an unpriced model reports unknown, not a notional nothing", () => {
    // `notional` claims we valued the row. Without a rate there is nothing to value it at.
    expect(
      estimateCost({
        provider: "anthropic-oauth",
        model: "claude-not-a-model",
        tokens: tokens({ tokensIn: 5_000 }),
        billing: "subscription",
      }),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })
})

describe("a long-context tier replaces the standard card, it does not top it up", () => {
  // Every vendor publishing one of these bills the *whole* request at the higher rate once the
  // prompt crosses the line. Charging only the excess would understate a long request by about half.
  test("a prompt one token under the threshold bills at the standard rate", () => {
    // Standard card: $5/Mtok input.
    expect(
      estimateCost({
        provider: "openai-api",
        model: "gpt-5.6-sol",
        tokens: tokens({ tokensIn: 271_999 }),
      }).costEstimate,
    ).toBe(((271_999 * 5) / 1_000_000).toFixed(6))
  })

  test("a prompt at the threshold bills the entire request at the long-context rate", () => {
    const long = estimateCost({
      provider: "openai-api",
      model: "gpt-5.6-sol",
      tokens: tokens({ tokensIn: 272_000 }),
    })
    // $10/Mtok across all 272k, not $5 on the first 272k plus $10 on nothing.
    expect(long.costEstimate).toBe((272_000 * (10 / 1_000_000)).toFixed(6))
  })

  test("the threshold is measured against the whole prompt, cached tokens included", () => {
    // What a long-context tier is measured against is how much context the request carried, not how
    // much of it happened to miss the cache.
    const split = estimateCost({
      provider: "openai-api",
      model: "gpt-5.6-sol",
      tokens: tokens({ tokensIn: 100_000, cacheReadTokens: 172_000 }),
    })
    // Long-context card: $10 input, $1 cached read.
    expect(split.costEstimate).toBe(((100_000 * 10 + 172_000 * 1) / 1_000_000).toFixed(6))
  })

  test("a model with no published tier is one price whatever the prompt", () => {
    const small = estimateCost({
      provider: "openai-api",
      model: "gpt-5.4-mini",
      tokens: tokens({ tokensIn: 1_000_000 }),
    })
    const huge = estimateCost({
      provider: "openai-api",
      model: "gpt-5.4-mini",
      tokens: tokens({ tokensIn: 2_000_000 }),
    })
    expect(Number(huge.costEstimate)).toBe(Number(small.costEstimate) * 2)
  })
})

describe("what the table does not know", () => {
  test("an unpriced model is null and unknown, never zero", () => {
    expect(
      estimateCost({
        provider: "anthropic-api",
        model: "claude-not-a-model",
        tokens: tokens({ tokensIn: 5_000 }),
      }),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("the four providers with no price to ship stay unknown by design", () => {
    // Not omissions. OpenRouter's price is whichever upstream it routed to, decided per request;
    // Ollama runs on the operator's own hardware; the two `*-compatible` hatches are the operator's
    // own contract with whatever they pointed at. A number here would be invented, not stale.
    for (const provider of [
      "openrouter",
      "ollama",
      "openai-compatible",
      "anthropic-compatible",
    ] as const) {
      expect(
        estimateCost({ provider, model: "gpt-5.6-sol", tokens: tokens({ tokensIn: 5_000 }) }),
      ).toEqual({ costEstimate: null, costBasis: "unknown" })
    }
  })

  test("an attempt that never selected an account has no provider to price against", () => {
    expect(
      estimateCost({
        provider: null,
        model: "claude-sonnet-5",
        tokens: tokens({ tokensIn: 5_000 }),
      }),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("an unpriced attempt is unknown whatever the account's billing says", () => {
    // Billing decides which of two priced bases is reported. It cannot conjure a price.
    for (const billing of ["metered", "subscription"] as const) {
      expect(
        estimateCost({
          provider: "ollama",
          model: "llama3",
          tokens: tokens({ tokensIn: 5_000 }),
          billing,
        }),
      ).toEqual({ costEstimate: null, costBasis: "unknown" })
    }
  })

  test("a count no column can hold reports unknown rather than failing the insert", () => {
    // `numeric(14, 6)` tops out under $100M. An upstream reporting a nonsense token count must not
    // take down the batch every other record is written in.
    expect(
      estimateCost({
        provider: "anthropic-api",
        model: "claude-fable-5",
        tokens: tokens({ tokensOut: 1e15 }),
      }),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })
})

describe("listing the shipped table", () => {
  // The settings screen renders these rows beside the operator's overrides, which is only possible
  // because the table can be enumerated at all — it used to be probeable one key at a time.
  test("every standard row agrees with the single-model lookup", () => {
    const rows = listShippedRates().filter((row) => row.fromPromptTokens === undefined)

    expect(rows.length).toBeGreaterThan(0)
    for (const { provider, model, ...rates } of rows) {
      const looked = lookupRates(provider, model)
      // The lookup returns the nested shape; a listed row is the flattened standard card.
      const { longContext: _tier, ...standard } = looked ?? {}
      expect(standard).toEqual(rates)
    }
  })

  test("a tiered model lists its tier as a second row under the same name", () => {
    const rows = listShippedRates().filter(
      (row) => row.provider === "openai-api" && row.model === "gpt-5.6-sol",
    )

    expect(rows.length).toBe(2)
    expect(rows[0]?.fromPromptTokens).toBeUndefined()
    expect(rows[1]?.fromPromptTokens).toBe(272_000)
    expect(lookupRates("openai-api", "gpt-5.6-sol")?.longContext?.fromPromptTokens).toBe(272_000)
  })

  test("both anthropic surfaces are listed, priced identically and separately", () => {
    const api = listShippedRates().filter((row) => row.provider === "anthropic-api")
    const oauth = listShippedRates().filter((row) => row.provider === "anthropic-oauth")

    // A subscription is valued at what the same tokens cost on the API, so it carries the same
    // rows — and an operator overriding one must be able to see it is not overriding the other.
    expect(oauth.length).toBe(api.length)
    expect(oauth.map((row) => row.model)).toEqual(api.map((row) => row.model))
  })

  test("every provider with a driver and a published price list is in the table", () => {
    const priced = new Set(listShippedRates().map((row) => row.provider))

    // The coverage claim, kept honest by naming the exceptions rather than counting rows: anything
    // not in this set must be one of the four that deliberately ship none.
    const unpriced = ProviderId.options.filter((id) => !priced.has(id))
    expect(unpriced.sort()).toEqual([
      "anthropic-compatible",
      "ollama",
      "openai-compatible",
      "openrouter",
    ])
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

  test("no shipped row carries a rate that could only be a placeholder", () => {
    for (const row of listShippedRates()) {
      for (const rate of [
        row.inputPerMtok,
        row.outputPerMtok,
        row.cacheReadPerMtok,
        row.cacheWritePerMtok,
      ]) {
        expect(Number.isFinite(rate)).toBe(true)
        expect(rate).toBeGreaterThanOrEqual(0)
        // Nothing published is per-Mtok in the thousands; a figure that high is a units mistake
        // (a per-token rate written as if it were per-million).
        expect(rate).toBeLessThan(1_000)
      }
      expect(row.outputPerMtok).toBeGreaterThanOrEqual(row.cacheReadPerMtok)
    }
  })
})

describe("dating the shipped table", () => {
  test("the table states the day it was checked, in a form a metric can parse", () => {
    // A price table with no date is a table nobody can judge: the numbers ship compiled into an
    // image and vendors reprice without asking. `router_price_table_asof_timestamp_seconds` is this
    // value, and an age past what a deployment tolerates is the alert.
    expect(PRICE_TABLE_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isFinite(Date.parse(`${PRICE_TABLE_AS_OF}T00:00:00Z`))).toBe(true)
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
    expect(
      estimateCost({
        provider: "anthropic-api",
        model: "claude-sonnet-5",
        tokens: counts,
        prices: flat,
      }),
    ).toEqual({ costEstimate: "300.000000", costBasis: "metered" })
    // The shipped table itself is untouched — an override layers over it, it does not replace it.
    expect(lookupRates("anthropic-api", "claude-sonnet-5")?.inputPerMtok).toBe(3)
  })

  test("prices a provider the shipped table has no list for at all", () => {
    // OpenRouter's price is decided per request by whichever upstream it chose, so only an operator
    // can say what one costs.
    expect(
      estimateCost({
        provider: "openrouter",
        model: "some/model",
        tokens: tokens({ tokensIn: 1_000_000 }),
        prices: flat,
      }),
    ).toEqual({ costEstimate: "100.000000", costBasis: "metered" })
  })

  test("is genuinely consulted: a lookup that knows nothing reports unknown", () => {
    // Proves the injection replaces the table rather than merging with it. If the shipped rate
    // leaked through here, an override that removed a price would silently keep charging.
    expect(
      estimateCost({
        provider: "anthropic-api",
        model: "claude-sonnet-5",
        tokens: tokens({ tokensIn: 1 }),
        prices: () => null,
      }),
    ).toEqual({ costEstimate: null, costBasis: "unknown" })
  })

  test("an override with no tier is one price whatever the prompt", () => {
    // An override is deliberately flat: writing one for a tiered model is the operator saying
    // "this is the rate, whatever the prompt", and a shipped tier must not leak back through it.
    const huge = estimateCost({
      provider: "openai-api",
      model: "gpt-5.6-sol",
      tokens: tokens({ tokensIn: 1_000_000 }),
      prices: flat,
    })
    expect(huge.costEstimate).toBe("100.000000")
  })

  test("omitting it prices exactly as passing the shipped table does", () => {
    const counts = tokens({ tokensIn: 4_000, cacheReadTokens: 9_000 })
    for (const model of ["claude-opus-4-8", "claude-not-a-model"]) {
      expect(estimateCost({ provider: "anthropic-api", model, tokens: counts })).toEqual(
        estimateCost({ provider: "anthropic-api", model, tokens: counts, prices: lookupRates }),
      )
    }
  })
})

describe("model name matching", () => {
  test("a dated snapshot prices as its family", () => {
    const snapshot = estimateCost({
      provider: "anthropic-api",
      model: "claude-haiku-4-5-20251001",
      tokens: tokens({ tokensIn: 1_000_000 }),
    })
    expect(snapshot).toEqual({ costEstimate: "1.000000", costBasis: "metered" })
  })

  test("an openai-style dated snapshot prices as its family too", () => {
    // The two vendors that pin dates spell them differently: `-20251001` and `-2025-04-14`.
    expect(lookupRates("openai-api", "gpt-4.1-2025-04-14")?.inputPerMtok).toBe(2)
  })

  test("a snapshot the vendor prices apart from its family keeps its own rate", () => {
    // The exact name is tried before the date is stripped, so an explicit row always wins.
    expect(lookupRates("openai-api", "gpt-4o-2024-05-13")?.inputPerMtok).toBe(5)
    expect(lookupRates("openai-api", "gpt-4o")?.inputPerMtok).toBe(2.5)
  })

  test("casing and stray whitespace do not lose a price", () => {
    expect(lookupRates("anthropic-api", "  Claude-Sonnet-5 ")?.inputPerMtok).toBe(3)
  })
})
