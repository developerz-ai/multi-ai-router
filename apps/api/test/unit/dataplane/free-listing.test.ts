import { describe, expect, test } from "bun:test"
import type { ProviderId } from "@multi-ai-router/core"
import { type CatalogModel, freeListing } from "../../../src/services/dataplane"
import { FREE_MODEL_RANKING, FREE_RANKING_AS_OF } from "../../../src/services/models"

function model(id: string, providers: readonly ProviderId[], contextTokens = 1_000): CatalogModel {
  return {
    id,
    providers,
    accounts: providers.length,
    contextTokens,
    maxOutputTokens: null,
    contextSource: "upstream",
    pricing: null,
    offers: providers.map((provider) => ({
      provider,
      accounts: 1,
      contextTokens,
      maxOutputTokens: null,
      contextSource: "upstream",
      pricing: null,
    })),
  }
}

const ids = (models: readonly CatalogModel[]) =>
  freeListing(models, FREE_MODEL_RANKING).map((entry) => entry.id)

describe("the free listing", () => {
  test("smart first, whatever order the catalog came in and however large the window", () => {
    expect(
      ids([
        model("inclusionai/ling-3.2-flash:free", ["kilo"], 1_048_576),
        model("nvidia/nemotron-3.5-super-vl:free", ["kilo", "openrouter"], 1_000_000),
        model("minimaxai/minimax-m3.1-flash", ["nvidia"], 200_000),
      ]),
    ).toEqual([
      "minimaxai/minimax-m3.1-flash",
      "nvidia/nemotron-3.5-super-vl:free",
      "inclusionai/ling-3.2-flash:free",
    ])
  })

  test("a paid model is never offered as free", () => {
    expect(
      ids([
        model("deepseek/deepseek-v4.1-flash-1017", ["openrouter"]),
        model("claude-opus-5-5", ["anthropic-oauth"]),
      ]),
    ).toEqual([])
  })

  test("an id free at one provider and billed at another is not free: the router may send it to either", () => {
    const id = "nvidia/nemotron-3-ultra-550b-a55b"

    expect(ids([model(id, ["nvidia"])])).toEqual([id])
    expect(ids([model(id, ["nvidia", "openrouter"])])).toEqual([])
  })

  test("a free variant the ranking has not judged is offered last, and says so", () => {
    const list = freeListing(
      [
        model("newlab/just-landed:free", ["openrouter"]),
        model("particle-ai/particle-1:free", ["openrouter"]),
      ],
      FREE_MODEL_RANKING,
    )

    expect(list.map(({ id, ranked }) => [id, ranked])).toEqual([
      ["particle-ai/particle-1:free", true],
      ["newlab/just-landed:free", false],
    ])
  })

  test("a :free spelling on a provider that does not define it proves nothing", () => {
    expect(ids([model("newlab/just-landed:free", ["openai-compatible"])])).toEqual([])
  })
})

describe("the shipped ranking", () => {
  test("every row names at least one id, no id is ranked twice, and the order is dated", () => {
    const seen = new Set<string>()
    for (const row of FREE_MODEL_RANKING) {
      const pairs = Object.entries(row.ids).flatMap(([provider, list]) =>
        list.map((id) => `${provider} ${id}`),
      )
      expect(pairs.length, row.name).toBeGreaterThan(0)
      for (const pair of pairs) {
        expect(seen.has(pair), pair).toBe(false)
        seen.add(pair)
      }
    }
    expect(FREE_RANKING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("on OpenRouter only a free variant is listed, because every other id there is billed", () => {
    for (const row of FREE_MODEL_RANKING) {
      for (const id of row.ids.openrouter ?? []) expect(id).toEndWith(":free")
    }
  })
})
