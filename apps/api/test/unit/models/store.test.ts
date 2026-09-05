import { describe, expect, test } from "bun:test"
import type { ModelCatalogRow } from "@multi-ai-router/db"
import { createModelCatalogStore } from "../../../src/services/models"

/**
 * The warm model catalog: read synchronously by the listing endpoint, replaced off the request
 * path by whichever replica ran the hourly sweep.
 *
 * The properties that matter are the ones the price book next door has, for the same reasons: a
 * failed refresh keeps the last good snapshot rather than emptying the router, and concurrent
 * refreshes share one query instead of racing to install the same rows.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function row(overrides: Partial<ModelCatalogRow> = {}): ModelCatalogRow {
  return {
    accountId: "acc-1",
    modelId: "glm-4.6",
    contextTokens: 204_800,
    maxOutputTokens: 131_072,
    contextSource: "shipped",
    listingSource: "upstream",
    resolvedModel: null,
    refreshedAt: NOW,
    ...overrides,
  }
}

const store = (load: () => Promise<readonly ModelCatalogRow[]>) =>
  createModelCatalogStore({ load, refreshIntervalMs: 60_000, now: () => NOW })

describe("the warm model catalog", () => {
  test("answers nothing before its first load rather than throwing", () => {
    const warm = store(async () => [])
    expect(warm.describe("acc-1", "glm-4.6")).toBeNull()
    expect(warm.modelsOf("acc-1")).toEqual([])
    expect(warm.loadedAt()).toBeNull()
  })

  test("describes a stored model and stamps when it loaded", async () => {
    const warm = store(async () => [row()])
    await warm.refresh()

    expect(warm.describe("acc-1", "glm-4.6")).toEqual({
      id: "glm-4.6",
      contextTokens: 204_800,
      maxOutputTokens: 131_072,
      contextSource: "shipped",
      listingSource: "upstream",
      resolvedModel: null,
    })
    expect(warm.loadedAt()).toEqual(NOW)
  })

  /**
   * The two sides of this lookup come from different places: the key is whatever the provider's
   * listing said, and the question is asked with whatever a client sent through an alias map.
   * `MiniMax-M2` and `minimax-m2` are one model, and rendering the second as unknown would look
   * like a gap in the sweep rather than a case difference.
   */
  test("spelling a model differently still finds it", async () => {
    const warm = store(async () => [row({ modelId: "MiniMax-M2" })])
    await warm.refresh()

    expect(warm.describe("acc-1", "minimax-m2")?.id).toBe("MiniMax-M2")
    expect(warm.describe("acc-1", "  MiniMax-M2  ")?.id).toBe("MiniMax-M2")
  })

  test("modelsOf is what a passthrough account's catalog is built from", async () => {
    const warm = store(async () => [
      row({ modelId: "glm-4.6" }),
      row({ modelId: "glm-5.2" }),
      row({ accountId: "other", modelId: "MiniMax-M2" }),
    ])
    await warm.refresh()

    expect(warm.modelsOf("acc-1").map((model) => model.id)).toEqual(["glm-4.6", "glm-5.2"])
    expect(warm.modelsOf("nobody")).toEqual([])
  })

  test("a failed refresh keeps the last good snapshot instead of emptying the router", async () => {
    let fail = false
    const warm = store(async () => {
      if (fail) throw new Error("connection reset")
      return [row()]
    })

    await warm.refresh()
    fail = true
    await expect(warm.refresh()).rejects.toThrow("connection reset")

    // Serving a slightly stale catalog beats serving none — an empty one reads as "this router
    // serves nothing".
    expect(warm.describe("acc-1", "glm-4.6")).not.toBeNull()
  })

  test("concurrent refreshes share one query", async () => {
    let queries = 0
    const warm = store(async () => {
      queries += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [row()]
    })

    await Promise.all([warm.refresh(), warm.refresh(), warm.refresh()])

    expect(queries).toBe(1)
  })

  /**
   * The cost of storing the provenance as `text` rather than a Postgres enum — which is the right
   * trade, since the label only describes a reading. A row written by a future build carrying a
   * source this build has never heard of reads as an unlabelled number, not as a bad label.
   */
  test("an unrecognized provenance is dropped rather than passed through", async () => {
    const warm = store(async () => [row({ contextSource: "telepathy" as never })])
    await warm.refresh()

    expect(warm.describe("acc-1", "glm-4.6")?.contextSource).toBeNull()
    expect(warm.describe("acc-1", "glm-4.6")?.contextTokens).toBe(204_800)
  })

  test("stopping a store that never started is harmless", () => {
    const warm = store(async () => [])
    expect(() => warm.stop()).not.toThrow()
    warm.start()
    warm.start()
    expect(() => warm.stop()).not.toThrow()
  })
})
