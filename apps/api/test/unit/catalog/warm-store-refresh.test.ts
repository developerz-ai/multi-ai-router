import { describe, expect, test } from "bun:test"
import type { ModelCatalogRow } from "@multi-ai-router/db"
import type { CatalogData } from "../../../src/services/catalog"
import { createRoutingCatalog } from "../../../src/services/catalog"
import { createModelCatalogStore } from "../../../src/services/models"
import { account } from "../dataplane/fixtures"

/**
 * Sweep 101, 04.5 + 02.8 + 04.7. A timer tick whose load fails used to be `.catch(() => undefined)`:
 * routing kept serving an hours-old snapshot and nothing said so. And the per-request lookups the
 * data plane makes must not rebuild what the snapshot already holds.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await tick()
}

function row(accountId: string, modelId: string): ModelCatalogRow {
  return {
    accountId,
    modelId,
    contextTokens: 1000,
    maxOutputTokens: null,
    contextSource: "upstream",
    listingSource: "upstream",
    resolvedModel: null,
    reasoning: null,
    refreshedAt: new Date(0),
  }
}

describe("routing catalog", () => {
  test("a failing tick reports once per failure, keeps the snapshot, and the next tick recovers", async () => {
    const good: CatalogData = { accounts: [account("a1")], pools: [] }
    const failure = new Error("pool exhausted")
    const outcomes: (CatalogData | Error)[] = [good, failure, good]
    const errors: unknown[] = []
    const store = createRoutingCatalog({
      load: async () => {
        const next = outcomes.shift() ?? good
        if (next instanceof Error) throw next
        return next
      },
      refreshIntervalMs: 1,
      jitter: () => 1,
      onRefreshError: (error) => errors.push(error),
    })
    await store.refresh()
    const installedAt = store.loadedAt()

    store.start()
    await waitFor(() => outcomes.length === 0)
    store.stop()

    expect(errors).toEqual([failure])
    expect(store.accounts().map((a) => a.id)).toEqual(["a1"])
    expect(store.loadedAt()).not.toBe(installedAt)
  })

  test("account(id) is answered from an index installed with the snapshot", async () => {
    const accounts = [account("a1"), account("a2")]
    const store = createRoutingCatalog({
      load: async () => ({ accounts, pools: [] }),
      refreshIntervalMs: 60_000,
    })
    expect(store.account("a1")).toBeUndefined()

    await store.refresh()

    expect(store.account("a2")).toBe(accounts[1])
    expect(store.account("missing")).toBeUndefined()
  })
})

describe("model catalog", () => {
  test("a failing tick reports to onRefreshError and keeps the rows", async () => {
    const failure = new Error("relation does not exist")
    const outcomes: (readonly ModelCatalogRow[] | Error)[] = [[row("a1", "m")], failure]
    const errors: unknown[] = []
    const store = createModelCatalogStore({
      load: async () => {
        const next = outcomes.shift() ?? failure
        if (next instanceof Error) throw next
        return next
      },
      refreshIntervalMs: 1,
      jitter: () => 1,
      onRefreshError: (error) => errors.push(error),
    })
    await store.refresh()

    store.start()
    await waitFor(() => errors.length > 0)
    store.stop()

    expect(errors[0]).toBe(failure)
    expect(store.describe("a1", "M")?.contextTokens).toBe(1000)
  })

  test("modelsOf returns the array built at load, not a fresh copy per call", async () => {
    const store = createModelCatalogStore({
      load: async () => [row("a1", "m1"), row("a1", "m2")],
      refreshIntervalMs: 60_000,
    })
    await store.refresh()

    const first = store.modelsOf("a1")
    expect(first.map((model) => model.id)).toEqual(["m1", "m2"])
    expect(store.modelsOf("a1")).toBe(first)
    expect(store.modelsOf("unknown")).toEqual([])
  })
})
