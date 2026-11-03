/**
 * Independent recorded expectations for every shipped vendor row.
 *
 * **Why this file exists.** The vendor tables under `services/cost/tables/` are the shipped price
 * table, and a wrong number in one of them is a wrong number in a spend column — a report nobody
 * can audit, because the report agrees with itself. The other cost tests exercise behaviour
 * (which basis a priced attempt reports under, what an unpriced model does). None of them pins the
 * numbers themselves, so a table edit could move a rate and the suite would stay green.
 *
 * So this file writes the cards out. It is deliberately **independent**: no production card
 * builder, no `rates()` helper, no tier multiplier, no table import. Every expected value is a
 * literal below, transcribed from the vendor's own published page. A change to the table that a
 * vendor page does not support fails here.
 *
 * **Provenance.** Every value was read from the vendor's published pricing page on **2026-11-03**;
 * the source URL and the read date for each vendor are in `services/cost/provenance.ts`
 * (`PRICE_SOURCES`). Where a vendor publishes a rate that is not derivable from another one — a
 * fast-mode rate, a discounted rate — the literal here is the vendor's figure, never a multiple.
 *
 * **Mutation record.** Every value in this file was changed one at a time in the corresponding
 * table file and this suite was re-run, so each pin is known to fail when the shipped number
 * moves. The table files were restored byte-for-byte afterwards.
 *
 * "card" is this file's word for one model's rate row: input, output, cached read and cached
 * write, per million tokens, in US dollars.
 */

import { describe, expect, test } from "bun:test"
import { lookupRates, PRICED_OFFERINGS_WITHOUT_PUBLISHED_ID } from "../../../src/services/cost"

/** One rate row: input, output, cached read, cached write — per million tokens, in USD. */
type Card = readonly [number, number, number, number]

/**
 * The card a model is expected to price at, on the surface named.
 *
 * The expected value is a literal, never computed from the shipped table.
 *
 * A model with a long-context tier publishes two cards, so the tier is checked separately: call
 * once with no threshold for the standard card, then again with the threshold for the tier.
 */
function expectCard(
  provider: Parameters<typeof lookupRates>[0],
  model: string,
  expected: Card,
  fromPromptTokens?: number,
): void {
  const looked = lookupRates(provider, model, billingFor(provider))
  expect(looked, `${provider}/${model} has no row`).not.toBeNull()
  if (looked === null) return
  if (fromPromptTokens === undefined) {
    const standard: Card = [
      looked.inputPerMtok,
      looked.outputPerMtok,
      looked.cacheReadPerMtok,
      looked.cacheWritePerMtok,
    ]
    expect(standard, `${provider}/${model} standard card`).toEqual(expected)
    return
  }
  expect(looked.longContext?.fromPromptTokens, `${provider}/${model} tier threshold`).toBe(
    fromPromptTokens,
  )
  const tier = looked.longContext
  expect(tier, `${provider}/${model} long-context tier`).toBeDefined()
  if (tier === undefined) return
  const actual: Card = [
    tier.inputPerMtok,
    tier.outputPerMtok,
    tier.cacheReadPerMtok,
    tier.cacheWritePerMtok,
  ]
  expect(actual, `${provider}/${model} long-context card`).toEqual(expected)
}

/**
 * The billing context a lookup needs.
 *
 * The Kimi rows are subscription reference rates: `lookupRates` refuses a metered Kimi account on
 * purpose, because those identities price a coding plan and nothing else. Every other provider
 * prices the same either way.
 */
function billingFor(provider: Parameters<typeof lookupRates>[0]) {
  return provider === "kimi" ? { billing: "subscription" as const } : undefined
}

/** A model the vendor publishes with no long-context tier at all. */
function expectNoTier(provider: Parameters<typeof lookupRates>[0], model: string): void {
  expect(
    lookupRates(provider, model, billingFor(provider))?.longContext,
    `${provider}/${model} long tier`,
  ).toBeUndefined()
}

describe("anthropic — platform.claude.com pricing, read 2026-11-03", () => {
  test("the current lineup", () => {
    expectCard("anthropic-api", "claude-opus-5-5", [4, 20, 0.2, 5])
    expectCard("anthropic-api", "claude-opus-5", [5, 25, 0.5, 6.25])
    expectCard("anthropic-api", "claude-fable-5-1", [10, 50, 0.25, 12.5])
    expectCard("anthropic-api", "claude-fable-5", [10, 50, 1, 12.5])
    expectCard("anthropic-api", "claude-mythos-5", [10, 50, 1, 12.5])
    expectCard("anthropic-api", "claude-sonnet-5-5", [2, 10, 0.2, 2.5])
    expectCard("anthropic-api", "claude-sonnet-5", [2, 10, 0.2, 2.5])
  })

  test("the legacy lineup", () => {
    expectCard("anthropic-api", "claude-opus-4-8", [5, 25, 0.5, 6.25])
    expectCard("anthropic-api", "claude-opus-4-7", [5, 25, 0.5, 6.25])
    expectCard("anthropic-api", "claude-opus-4-6", [5, 25, 0.5, 6.25])
    expectCard("anthropic-api", "claude-opus-4-5", [5, 25, 0.5, 6.25])
    expectCard("anthropic-api", "claude-opus-4-1", [15, 75, 1.5, 18.75])
    expectCard("anthropic-api", "claude-opus-4", [15, 75, 1.5, 18.75])
    expectCard("anthropic-api", "claude-sonnet-4-6", [3, 15, 0.3, 3.75])
    expectCard("anthropic-api", "claude-sonnet-4-5", [3, 15, 0.3, 3.75])
    expectCard("anthropic-api", "claude-sonnet-4", [3, 15, 0.3, 3.75])
    expectCard("anthropic-api", "claude-haiku-4-5", [1, 5, 0.1, 1.25])
    expectCard("anthropic-api", "claude-3-haiku", [0.25, 1.25, 0.025, 0.3125])
  })

  test("no Anthropic model publishes a long-context tier", () => {
    // Anthropic's 4.6-and-later models carry a 1M context window at standard pricing, so there is
    // no second card to state.
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1"]) {
      expectNoTier("anthropic-api", model)
    }
  })

  test("the subscription surface prices identically to the metered one", () => {
    expectCard("anthropic-oauth", "claude-opus-5-5", [4, 20, 0.2, 5])
    expectCard("anthropic-oauth", "claude-sonnet-5", [2, 10, 0.2, 2.5])
  })

  /**
   * The gap this closes: fast mode is a request flag on the ordinary id, and Anthropic publishes
   * no fast-mode model id. A row under any of these names would price a model Anthropic does not
   * serve — and Opus 4.7 has no fast mode at all, so a "6x" figure for it is a number nobody
   * published.
   */
  test("no fast-mode model id is priced, because Anthropic publishes none", () => {
    for (const model of [
      "claude-opus-5-5-fast",
      "claude-opus-5-fast",
      "claude-opus-4-8-fast",
      "claude-opus-4-7-fast",
      "claude-mythos-5-1-fast",
    ]) {
      expect(lookupRates("anthropic-api", model), `${model} must not be priced`).toBeNull()
    }
  })

  /**
   * Mythos 5.1 is priced on the page but published under no model id: the id appears in no
   * catalog, on no context-window table, and nowhere else the router serves a model by name. A
   * row for it would price a name Anthropic does not serve, so it lives in the offerings registry
   * instead and a request naming it prices as unknown.
   */
  test("Mythos 5.1 has no published model id, so it has no row", () => {
    expect(lookupRates("anthropic-api", "claude-mythos-5-1")).toBeNull()
    expect(lookupRates("anthropic-oauth", "claude-mythos-5-1")).toBeNull()
  })
})

describe("openai — developers.openai.com pricing, read 2026-11-03", () => {
  test("the GPT-5.6 family", () => {
    expectCard("openai-api", "gpt-5.6-sol", [4, 20, 0.4, 5])
    expectCard("openai-api", "gpt-5.6-sol", [8, 30, 0.8, 10], 272_000)
    expectCard("openai-api", "gpt-5.6", [4, 20, 0.4, 5])
    expectCard("openai-api", "gpt-5.6-terra", [2, 12, 0.2, 2.5])
    expectCard("openai-api", "gpt-5.6-terra", [4, 18, 0.4, 5], 272_000)
    expectCard("openai-api", "gpt-5.6-luna", [0.2, 1.2, 0.02, 0.25])
    expectCard("openai-api", "gpt-5.6-luna", [0.4, 1.8, 0.04, 0.5], 272_000)
  })

  test("the GPT-6 family", () => {
    expectCard("openai-api", "gpt-6-luna", [0.1, 0.5, 0.01, 0.125])
    expectCard("openai-api", "gpt-6-luna", [0.2, 0.75, 0.02, 0.25], 272_000)
    expectCard("openai-api", "gpt-6-sol", [2, 10, 0.2, 2.5])
    expectCard("openai-api", "gpt-6-sol", [4, 15, 0.4, 5], 272_000)
    expectCard("openai-api", "gpt-6.1-sol", [2, 10, 0.1, 2.5])
    expectCard("openai-api", "gpt-6.1-sol", [4, 15, 0.2, 5], 272_000)
    expectCard("openai-api", "gpt-6-astra", [10, 50, 1, 12.5])
    expectCard("openai-api", "gpt-6-astra", [20, 75, 2, 25], 272_000)
  })

  test("the GPT-5 family", () => {
    expectCard("openai-api", "gpt-5.5", [5, 30, 0.5, 0])
    expectCard("openai-api", "gpt-5.5", [10, 45, 1, 0], 272_000)
    expectCard("openai-api", "gpt-5.5-pro", [30, 180, 30, 0])
    expectCard("openai-api", "gpt-5.4", [2.5, 15, 0.25, 0])
    expectCard("openai-api", "gpt-5.4", [5, 22.5, 0.5, 0], 272_000)
    expectCard("openai-api", "gpt-5.4-pro", [30, 180, 30, 0])
    expectCard("openai-api", "gpt-5.4-mini", [0.75, 4.5, 0.075, 0])
    expectCard("openai-api", "gpt-5.4-nano", [0.2, 1.25, 0.02, 0])
    expectCard("openai-api", "gpt-5.3-codex", [1.75, 14, 0.175, 0])
    expectCard("openai-api", "gpt-5.2", [1.75, 14, 0.175, 0])
    expectCard("openai-api", "gpt-5.2-pro", [21, 168, 21, 0])
    expectCard("openai-api", "gpt-5.1", [1.25, 10, 0.125, 0])
    expectCard("openai-api", "gpt-5", [1.25, 10, 0.125, 0])
    expectCard("openai-api", "gpt-5-mini", [0.25, 2, 0.025, 0])
    expectCard("openai-api", "gpt-5-nano", [0.05, 0.4, 0.005, 0])
    expectCard("openai-api", "gpt-5-pro", [15, 120, 15, 0])
    // The `pro` models publish no long-context rate, and the mini and nano tiers publish none
    // either — one price, whatever the prompt.
    expectNoTier("openai-api", "gpt-5.5-pro")
    expectNoTier("openai-api", "gpt-5.4-pro")
    expectNoTier("openai-api", "gpt-5.4-mini")
    expectNoTier("openai-api", "gpt-5.4-nano")
  })

  test("the GPT-4 line and the reasoning models", () => {
    expectCard("openai-api", "gpt-4.1", [2, 8, 0.5, 0])
    expectCard("openai-api", "gpt-4.1-mini", [0.4, 1.6, 0.1, 0])
    expectCard("openai-api", "gpt-4.1-nano", [0.1, 0.4, 0.025, 0])
    expectCard("openai-api", "gpt-4o", [2.5, 10, 1.25, 0])
    expectCard("openai-api", "gpt-4o-2024-05-13", [5, 15, 5, 0])
    expectCard("openai-api", "gpt-4o-mini", [0.15, 0.6, 0.075, 0])
    expectCard("openai-api", "chat-latest", [5, 30, 0.5, 0])
    expectCard("openai-api", "o3", [2, 8, 0.5, 0])
    expectCard("openai-api", "o3-pro", [20, 80, 20, 0])
    expectCard("openai-api", "o3-mini", [1.1, 4.4, 0.55, 0])
    expectCard("openai-api", "o4-mini", [1.1, 4.4, 0.275, 0])
    expectCard("openai-api", "o1", [15, 60, 7.5, 0])
    expectCard("openai-api", "o1-pro", [150, 600, 150, 0])
    expectCard("openai-api", "o1-mini", [1.1, 4.4, 0.55, 0])
  })

  test("the subscription surface prices identically to the metered one", () => {
    expectCard("openai-oauth", "gpt-5.6-sol", [4, 20, 0.4, 5])
    expectCard("openai-oauth", "gpt-6-sol", [2, 10, 0.2, 2.5])
  })
})

describe("google — ai.google.dev pricing, read 2026-11-03", () => {
  test("the Pro line is the only tiered one", () => {
    expectCard("gemini", "gemini-3.1-pro-preview", [2, 12, 0.2, 0])
    expectCard("gemini", "gemini-3.1-pro-preview", [4, 18, 0.4, 0], 200_000)
    expectCard("gemini", "gemini-2.5-pro", [1.25, 10, 0.125, 0])
    expectCard("gemini", "gemini-2.5-pro", [2.5, 15, 0.25, 0], 200_000)
  })

  test("the Flash line is one price whatever the prompt", () => {
    expectCard("gemini", "gemini-3.8-flash", [0.75, 3.75, 0.075, 0])
    expectCard("gemini", "gemini-3.6-flash", [0.75, 3.75, 0.075, 0])
    expectCard("gemini", "gemini-3.5-flash-lite", [0.3, 2.5, 0.03, 0])
    expectCard("gemini", "gemini-3.1-flash-lite", [0.25, 1.5, 0.025, 0])
    expectCard("gemini", "gemini-3-flash-preview", [0.5, 3, 0.05, 0])
    expectCard("gemini", "gemini-2.5-flash", [0.3, 2.5, 0.03, 0])
    expectCard("gemini", "gemini-2.5-flash-lite", [0.1, 0.4, 0.01, 0])
    expectNoTier("gemini", "gemini-3.8-flash")
    expectNoTier("gemini", "gemini-2.5-flash-lite")
  })

  test("the deprecated 3.5 Flash is not priced — it is auto-routed to 3.6", () => {
    expect(lookupRates("gemini", "gemini-3.5-flash")).toBeNull()
  })
})

describe("zai — docs.z.ai pricing, read 2026-11-03", () => {
  test("the current lineup", () => {
    expectCard("zai", "glm-5.3", [1.4, 4.4, 0.26, 0])
    expectCard("zai", "glm-5.2", [1.4, 4.4, 0.26, 0])
    expectCard("zai", "glm-5.1", [1.4, 4.4, 0.26, 0])
    expectCard("zai", "glm-5", [1, 3.2, 0.2, 0])
    expectCard("zai", "glm-5.3-flash", [0.15, 0.5, 0.03, 0])
    expectCard("zai", "glm-5.3-flashx", [0.37, 1.25, 0.075, 0])
  })

  test("the legacy lineup", () => {
    expectCard("zai", "glm-4.7", [0.6, 2.2, 0.11, 0])
    expectCard("zai", "glm-4.7-flashx", [0.07, 0.4, 0.01, 0])
    expectCard("zai", "glm-4.6", [0.6, 2.2, 0.11, 0])
    expectCard("zai", "glm-4.5", [0.6, 2.2, 0.11, 0])
    expectCard("zai", "glm-4.5-x", [2.2, 8.9, 0.45, 0])
    expectCard("zai", "glm-4.5-air", [0.2, 1.1, 0.03, 0])
    expectCard("zai", "glm-4.5-airx", [1.1, 4.5, 0.22, 0])
    expectCard("zai", "glm-4-32b-0414-128k", [0.1, 0.1, 0.1, 0])
  })

  test("the free Flash models are priced at zero — a measurement, not a gap", () => {
    expectCard("zai", "glm-4.7-flash", [0, 0, 0, 0])
    expectCard("zai", "glm-4.5-flash", [0, 0, 0, 0])
  })
})

describe("minimax — platform.minimax.io pricing, read 2026-11-03", () => {
  test("M3 keeps its two input-length bands", () => {
    expectCard("minimax", "minimax-m3", [0.3, 1.2, 0.06, 0])
    expectCard("minimax", "minimax-m3", [0.6, 2.4, 0.12, 0], 512_000)
  })

  test("M3.1 Flash is one price whatever the prompt", () => {
    expectCard("minimax", "minimax-m3.1-flash", [0.15, 0.6, 0.015, 0])
  })

  test("the off-list M2 line is not priced", () => {
    for (const model of ["minimax-m2.7", "minimax-m2.5", "minimax-m2.1", "minimax-m2"]) {
      expect(lookupRates("minimax", model), `${model} is off the price list`).toBeNull()
    }
  })
})

describe("cerebras — cerebras.ai pricing, read 2026-11-03", () => {
  test("the Developer Tier table", () => {
    expectCard("cerebras", "gpt-oss-120b", [0.35, 0.75, 0.35, 0])
    expectCard("cerebras", "qwen-3.8-27b", [0.99, 1.49, 0.99, 0])
  })

  test("the models that left the price table are not priced", () => {
    for (const model of ["zai-glm-4.7", "gemma-4-31b"]) {
      expect(lookupRates("cerebras", model), `${model} is off the price table`).toBeNull()
    }
  })
})

describe("deepseek — api-docs.deepseek.com pricing, read 2026-11-03", () => {
  test("the peak rates, which are the standing ones", () => {
    expectCard("deepseek", "deepseek-flash", [0.3, 1.2, 0.006, 0])
    expectCard("deepseek", "deepseek-v4-pro", [1.32, 3.96, 0.044, 0])
  })

  test("the retired flash id is not priced under its old name", () => {
    expect(lookupRates("deepseek", "deepseek-v4-flash")).toBeNull()
  })
})

describe("groq — console.groq.com pricing, read 2026-11-03", () => {
  test("the published rows", () => {
    expectCard("groq", "openai/gpt-oss-120b", [0.15, 0.6, 0.075, 0])
    expectCard("groq", "openai/gpt-oss-20b", [0.075, 0.3, 0.0375, 0])
    expectCard("groq", "openai/gpt-oss-safeguard-20b", [0.075, 0.3, 0.0375, 0])
    expectCard("groq", "qwen/qwen3.8-27b", [0.8, 4, 0.4, 0])
    expectCard("groq", "meta-llama/llama-prompt-guard-2-22m", [0.03, 0.03, 0.03, 0])
    expectCard("groq", "meta-llama/llama-prompt-guard-2-86m", [0.04, 0.04, 0.04, 0])
  })

  test("the Enterprise Llama rows have no published price to state", () => {
    for (const model of ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]) {
      expect(lookupRates("groq", model), `${model} is priced by agreement`).toBeNull()
    }
  })
})

describe("kimi coding references — platform.kimi.ai pricing, read 2026-11-03", () => {
  test("the coding identities carry their platform model's rate", () => {
    expectCard("kimi", "k3", [3, 15, 0.3, 0])
    expectCard("kimi", "k3-256k", [3, 15, 0.3, 0])
    expectCard("kimi", "k3.1-pro", [2, 10, 0.2, 0])
    expectCard("kimi", "k3.1-pro-highspeed", [4, 20, 0.2, 0])
    expectCard("kimi", "kimi-for-coding-highspeed", [1.9, 8, 0.38, 0])
  })
})

describe("mistral — mistral.ai pricing, read 2026-11-03", () => {
  test("the models on the price list", () => {
    expectCard("mistral", "mistral-large-latest", [0.7, 2.1, 0.07, 0])
    expectCard("mistral", "mistral-small-latest", [0.15, 0.6, 0.015, 0])
    expectCard("mistral", "ministral-14b-latest", [0.2, 0.2, 0.02, 0])
    expectCard("mistral", "ministral-8b-latest", [0.15, 0.15, 0.015, 0])
    expectCard("mistral", "ministral-3b-latest", [0.1, 0.1, 0.01, 0])
    expectCard("mistral", "codestral-latest", [0.3, 0.9, 0.03, 0])
  })

  test("the lines that left the price list are not priced", () => {
    for (const model of [
      "mistral-medium-latest",
      "devstral-medium-latest",
      "devstral-small-latest",
      "magistral-medium-latest",
      "magistral-small-latest",
      "open-mixtral-8x22b",
      "open-mixtral-8x7b",
      "open-mistral-nemo",
    ]) {
      expect(lookupRates("mistral", model), `${model} is off the price list`).toBeNull()
    }
  })
})

describe("together — docs.together.ai serverless prices, read 2026-11-03", () => {
  test("the published serverless rows", () => {
    expectCard("together", "deepseek-ai/deepseek-v4-pro-0813", [1.32, 3.96, 0.13, 0])
    expectCard("together", "deepseek-ai/deepseek-v4.1-flash", [0.3, 1.2, 0.006, 0])
    expectCard("together", "deepseek-ai/deepseek-v4.1-flash-1017", [0.3, 1.2, 0.006, 0])
    expectCard("together", "meta-models/muse-glimmer-30b", [0.35, 1.5, 0.04, 0])
    expectCard("together", "meta-models/muse-spark-open-816b-a42b", [1.25, 4.25, 0.15, 0])
    expectCard("together", "minimaxai/minimax-m3.1-flash", [0.15, 0.6, 0.015, 0])
    expectCard("together", "moonshotai/kimi-k3", [3, 15, 0.3, 0])
    expectCard("together", "nvidia/nvidia-nemotron-3.5-super-vl", [0.15, 0.5, 0.02, 0])
    expectCard("together", "openai/gpt-oss-120b", [0.15, 0.6, 0.15, 0])
    expectCard("together", "qwen/qwen3.5-9b", [0.17, 0.25, 0.17, 0])
    expectCard("together", "qwen/qwen3.6-plus", [0.5, 3, 0.5, 0])
    expectCard("together", "qwen/qwen3.7-plus", [0.32, 1.28, 0.32, 0])
    expectCard("together", "qwen/qwen3.8-flash", [0.15, 0.47, 0.15, 0])
    expectCard("together", "reflection/beam-1.0-501b-a23b", [0.4, 1.2, 0.04, 0])
    expectCard("together", "zai-org/glm-5.2", [1.4, 4.4, 0.26, 0])
    expectCard("together", "zai-org/glm-5.3", [1.4, 4.4, 0.26, 0])
    expectCard("together", "zai-org/glm-5.3-flash", [0.15, 0.5, 0.03, 0])
  })

  test("Qwen3.7 Max stays absent: the vendor's two pages still disagree", () => {
    expect(lookupRates("together", "qwen/qwen3.7-max")).toBeNull()
  })
})

describe("xai — docs.x.ai pricing, read 2026-11-03", () => {
  test("the current lineup, with its 200k long-context bands", () => {
    expectCard("xai", "grok-4.7", [2, 6, 0.5, 0])
    expectCard("xai", "grok-4.7", [4, 12, 1, 0], 200_000)
    expectCard("xai", "grok-4.6", [2, 6, 0.5, 0])
    expectCard("xai", "grok-4.6", [4, 12, 1, 0], 200_000)
    expectCard("xai", "grok-4.5", [2, 6, 0.3, 0])
    expectCard("xai", "grok-4.5", [4, 12, 0.6, 0], 200_000)
    expectCard("xai", "grok-4.5-latest", [2, 6, 0.3, 0])
    expectCard("xai", "grok-build-latest", [2, 6, 0.3, 0])
    expectCard("xai", "grok-4.3", [1.25, 2.5, 0.2, 0])
    expectCard("xai", "grok-4.3", [2.5, 5, 0.4, 0], 200_000)
  })

  test("the 4.20 line bills at the 4.3 rate", () => {
    expectCard("xai", "grok-4.20-0309-reasoning", [1.25, 2.5, 0.2, 0])
    expectCard("xai", "grok-4.20-0309-reasoning", [2.5, 5, 0.4, 0], 200_000)
    expectCard("xai", "grok-4.20-0309-non-reasoning", [1.25, 2.5, 0.2, 0])
    expectCard("xai", "grok-4.20-multi-agent-0309", [1.25, 2.5, 0.2, 0])
  })

  test("the coding model, under the three published aliases that point at it", () => {
    expectCard("xai", "grok-build-0.1", [1, 2, 0.2, 0])
    expectCard("xai", "grok-build-0.1", [2, 4, 0.4, 0], 200_000)
    expectCard("xai", "grok-code-fast", [1, 2, 0.2, 0])
    expectCard("xai", "grok-code-fast-1", [1, 2, 0.2, 0])
    expectCard("xai", "grok-code-fast-1-0825", [1, 2, 0.2, 0])
  })

  test("the retired slugs are not priced", () => {
    for (const model of ["grok-4", "grok-3", "grok-3-mini", "grok-4-fast-1"]) {
      expect(lookupRates("xai", model), `${model} was retired`).toBeNull()
    }
  })
})

describe("offerings that have no published model id", () => {
  /**
   * The registry is a record of what a vendor publishes, so every entry is pinned by its exact
   * name and its exact published figure.
   *
   * The figures are the vendor's own, written out — never a multiple of a base rate. Opus 5.5
   * fast is $8 / $40 and Opus 5 and Opus 4.8 fast are $10 / $50 *as Anthropic states them*, and
   * Mythos 5.1 is $10 / $50 with the 0.025x cached-read footnote. A registry entry that carried a
   * derived multiple would read as a published price and be wrong in a way nobody can audit.
   */
  test("the registry names every offering and states the vendor's own published price", () => {
    const expected = new Map<string, string>([
      ["Claude Opus 5.5 fast mode", "$8 / MTok input, $40 / MTok output"],
      ["Claude Opus 5 fast mode", "$10 / MTok input, $50 / MTok output"],
      ["Claude Opus 4.8 fast mode", "$10 / MTok input, $50 / MTok output"],
      [
        "Claude Mythos 5.1",
        "$10 / MTok input, $50 / MTok output, cached read 0.025x ($0.25 / MTok)",
      ],
    ])
    expect(PRICED_OFFERINGS_WITHOUT_PUBLISHED_ID.length).toBe(expected.size)
    // Iterate the *expected* map, not the registry: a registry that dropped an offering would
    // otherwise leave the surviving entries passing, and the missing one would go unnoticed.
    for (const [name, publishedPrice] of expected) {
      const entry = PRICED_OFFERINGS_WITHOUT_PUBLISHED_ID.find((o) => o.offering === name)
      expect(entry, name).toBeDefined()
      if (entry === undefined) continue
      expect(entry.provider, name).toBe("anthropic-api")
      expect(entry.publishedPrice, name).toBe(publishedPrice)
      expect(entry.reason.length, name).toBeGreaterThan(0)
    }
    // The named set itself: a registry that carried an extra offering would leave the rest intact.
    expect(new Set(PRICED_OFFERINGS_WITHOUT_PUBLISHED_ID.map((o) => o.offering))).toEqual(
      new Set(expected.keys()),
    )
  })

  test("no offering is priced under an invented id", () => {
    // The registry is a record, not a price card: an offering with no published model id must
    // price as unknown rather than at a guessed rate.
    for (const offering of PRICED_OFFERINGS_WITHOUT_PUBLISHED_ID) {
      for (const model of [
        "claude-opus-5-5-fast",
        "claude-opus-5-fast",
        "claude-opus-4-8-fast",
        "claude-opus-4-7-fast",
        "claude-mythos-5-1-fast",
        "claude-mythos-5-1",
      ]) {
        expect(lookupRates(offering.provider, model), `${model} has no published id`).toBeNull()
      }
    }
  })
})
