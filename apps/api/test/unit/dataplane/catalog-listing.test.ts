import { describe, expect, test } from "bun:test"
import type { ModelDescriptor } from "@multi-ai-router/core"
import type { CatalogListingDeps, VerifiedKey } from "../../../src/services/dataplane"
import { catalogListing, providerListing } from "../../../src/services/dataplane"
import { account, catalog, health, NOW } from "./fixtures"

/**
 * `GET /v1/catalog` — the router's own listing, with a size and a price beside each model.
 *
 * Two properties are worth more than the rest. **Scope is not re-implemented here**: the model set
 * comes from the same intersection `/v1/models` uses, because a second opinion about what a key can
 * reach would be wrong in the direction of publishing a catalog of models the key cannot use. And
 * **a passthrough account still has a catalog**: an account declaring no `supported_models` serves
 * any name and therefore advertises nothing enumerable, yet its upstream has told the sweep exactly
 * what it serves — listing those is the difference between a catalog and an empty page.
 */

function fullScope(): VerifiedKey {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-key",
    prefix: "mar_live_test",
    scope: { kind: "all" },
    rateLimitRequests: null,
    rateLimitWindowSeconds: null,
    expiresAt: null,
  }
}

function scopedTo(accountIds: readonly string[]): VerifiedKey {
  return { ...fullScope(), scope: { kind: "accounts", accountIds: [...accountIds] } }
}

/** A stub warm catalog: `accountId -> upstream id -> what the sweep stored`. */
function models(
  table: Record<string, Record<string, Partial<ModelDescriptor>>>,
): CatalogListingDeps["models"] {
  const describe_ = (accountId: string, id: string): ModelDescriptor | null => {
    const entry = table[accountId]?.[id]
    if (entry === undefined) return null
    return {
      id,
      contextTokens: entry.contextTokens ?? null,
      maxOutputTokens: entry.maxOutputTokens ?? null,
      contextSource: entry.contextSource ?? null,
    }
  }
  return {
    describe: describe_,
    modelsOf: (accountId) =>
      Object.keys(table[accountId] ?? {}).flatMap((id) => describe_(accountId, id) ?? []),
  }
}

const noPrices: CatalogListingDeps["prices"] = () => null

describe("the rich catalog listing", () => {
  test("a passthrough account publishes what its upstream listed, not nothing", () => {
    // No `supportedModels`, no aliases: `/v1/models` would show an empty router here.
    const list = catalogListing(
      {
        catalog: catalog([account("a", { provider: "zai" })]),
        health: health(),
        models: models({ a: { "glm-4.6": { contextTokens: 204_800, contextSource: "shipped" } } }),
        prices: noPrices,
      },
      fullScope(),
      NOW,
    )

    expect(list).toEqual([
      {
        id: "glm-4.6",
        providers: ["zai"],
        accounts: 1,
        contextTokens: 204_800,
        maxOutputTokens: null,
        contextSource: "shipped",
        pricing: null,
      },
    ])
  })

  /**
   * The check that keeps the catalog from promising a 503. A discovered id is admitted only if
   * `resolveModel` says a request for it would actually be served.
   */
  test("a declared model set still bounds what the catalog publishes", () => {
    const list = catalogListing(
      {
        catalog: catalog([
          account("a", { provider: "zai", snapshot: { supportedModels: ["glm-4.6"] } }),
        ]),
        health: health(),
        // The upstream lists a model this account is not allowed to serve.
        models: models({ a: { "glm-4.6": {}, "glm-5.2": {} } }),
        prices: noPrices,
      },
      fullScope(),
      NOW,
    )

    expect(list.map((entry) => entry.id)).toEqual(["glm-4.6"])
  })

  test("an alias is published under the name a client sends, sized by what it maps to", () => {
    const list = catalogListing(
      {
        catalog: catalog([account("a", { provider: "zai", modelAliases: { sonnet: "glm-4.7" } })]),
        health: health(),
        models: models({ a: { "glm-4.7": { contextTokens: 204_800, contextSource: "shipped" } } }),
        prices: noPrices,
      },
      fullScope(),
      NOW,
    )

    // **Both** names, and both are true. `sonnet` is the alias an operator wrote down; `glm-4.7` is
    // requestable too, because an account declaring no model set passes any name through unchanged.
    // Listing only the alias would hide a name that works; listing only the upstream id would hide
    // the one the operator created the account to offer.
    expect(list.map((entry) => entry.id)).toEqual(["glm-4.7", "sonnet"])
    // Requested-side name, upstream-side metadata — the two sides of the alias map.
    expect(list.find((entry) => entry.id === "sonnet")).toMatchObject({
      contextTokens: 204_800,
      contextSource: "shipped",
    })
  })

  test("scope is the same intersection everything else uses", () => {
    const deps = {
      catalog: catalog([
        account("mine", { provider: "zai" }),
        account("theirs", { provider: "minimax" }),
      ]),
      health: health(),
      models: models({ mine: { "glm-4.6": {} }, theirs: { "MiniMax-M2": {} } }),
      prices: noPrices,
    }

    const list = catalogListing(deps, scopedTo(["mine"]), NOW)

    // An out-of-scope account does not exist here, including in this listing.
    expect(list.map((entry) => entry.id)).toEqual(["glm-4.6"])
  })

  test("pooling depth is the useful fact, so accounts and providers are counted not collapsed", () => {
    const list = catalogListing(
      {
        catalog: catalog([
          account("one", { provider: "zai" }),
          account("two", { provider: "zai" }),
          account("three", { provider: "openai-compatible" }),
        ]),
        health: health(),
        models: models({
          one: { shared: {} },
          two: { shared: {} },
          three: { shared: {} },
        }),
        prices: noPrices,
      },
      fullScope(),
      NOW,
    )

    expect(list[0]).toMatchObject({
      id: "shared",
      accounts: 3,
      providers: ["openai-compatible", "zai"],
    })
  })

  test("a known size beats an unknown one, whichever account happened to be first", () => {
    const list = catalogListing(
      {
        catalog: catalog([
          account("blank", { provider: "zai" }),
          account("swept", { provider: "zai" }),
        ]),
        health: health(),
        models: models({
          blank: { shared: {} },
          swept: { shared: { contextTokens: 128_000, contextSource: "upstream" } },
        }),
        prices: noPrices,
      },
      fullScope(),
      NOW,
    )

    // Disagreement here means one account has been swept and the other has not.
    expect(list[0]).toMatchObject({ contextTokens: 128_000, contextSource: "upstream" })
  })

  test("the price comes from the same book a usage report is priced against", () => {
    const list = catalogListing(
      {
        catalog: catalog([account("a", { provider: "zai", modelAliases: { sonnet: "glm-4.7" } })]),
        health: health(),
        models: models({ a: { "glm-4.7": {} } }),
        // Priced by the *upstream* name, which is what actually gets billed.
        prices: (_provider, model) =>
          model === "glm-4.7"
            ? { inputPerMtok: 1, outputPerMtok: 2, cacheReadPerMtok: 0.1, cacheWritePerMtok: 0 }
            : null,
      },
      fullScope(),
      NOW,
    )

    // The alias resolves to `glm-4.7` on the way out, so that is the name the bill carries.
    expect(list.find((entry) => entry.id === "sonnet")?.pricing).toEqual({
      inputPerMtok: 1,
      outputPerMtok: 2,
      cacheReadPerMtok: 0.1,
      cacheWritePerMtok: 0,
    })
  })

  test.each([["disabled"], ["exhausted"], ["needs_reauth"]] as const)(
    "a %s account contributes nothing — the same rule /v1/models follows",
    (status) => {
      const list = catalogListing(
        {
          catalog: catalog([account("a", { provider: "zai", snapshot: { status } })]),
          health: health(),
          models: models({ a: { "glm-4.6": {} } }),
          prices: noPrices,
        },
        fullScope(),
        NOW,
      )

      expect(list).toEqual([])
    },
  )

  test("a cooling account still contributes — that block clears on a clock", () => {
    const list = catalogListing(
      {
        catalog: catalog([account("a", { provider: "zai", snapshot: { status: "cooling_down" } })]),
        health: health(),
        models: models({ a: { "glm-4.6": {} } }),
        prices: noPrices,
      },
      fullScope(),
      NOW,
    )

    expect(list.map((entry) => entry.id)).toEqual(["glm-4.6"])
  })

  test("an empty catalog is an empty list, never an invented one", () => {
    expect(
      catalogListing(
        { catalog: catalog([]), health: health(), models: models({}), prices: noPrices },
        fullScope(),
        NOW,
      ),
    ).toEqual([])
  })
})

describe("the provider listing", () => {
  test("counts in-scope accounts and how many of them could serve right now", () => {
    const list = providerListing(
      {
        catalog: catalog([
          account("live", { provider: "zai" }),
          account("spent", { provider: "zai", snapshot: { status: "exhausted" } }),
          account("other", { provider: "minimax" }),
        ]),
        health: health(),
      },
      fullScope(),
      NOW,
    )

    expect(list).toEqual([
      { id: "minimax", accounts: 1, available: 1 },
      // The state worth seeing: two credentials exist, one can be used.
      { id: "zai", accounts: 2, available: 1 },
    ])
  })

  test("a provider with no in-scope account is absent, not present with a zero", () => {
    const list = providerListing(
      {
        catalog: catalog([
          account("mine", { provider: "zai" }),
          account("theirs", { provider: "minimax" }),
        ]),
        health: health(),
      },
      scopedTo(["mine"]),
      NOW,
    )

    // Absent means "never configured for this key"; `available: 0` would mean "configured and
    // unusable", which is a different thing to tell an operator.
    expect(list.map((entry) => entry.id)).toEqual(["zai"])
  })
})
