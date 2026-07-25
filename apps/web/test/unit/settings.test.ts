import { describe, expect, test } from "bun:test"
import {
  buildPriceOverridePayload,
  diffOverrides,
  type ModelRates,
  mergePriceRows,
  type PriceOverride,
  type PriceRate,
  withRates,
} from "../../src/lib/api/settings"

/**
 * The price table the settings screen edits, before any of it reaches the wire.
 *
 * The endpoint is covered against a real database on the API side. What is pinned here is the
 * classification and the payload arithmetic the console does *after* the wire, because that is
 * where a screen can quietly store a price nobody typed or drop one somebody did.
 */

const rates = (input: number, output: number): ModelRates => ({
  inputPerMtok: input,
  outputPerMtok: output,
  cacheReadPerMtok: input * 0.1,
  cacheWritePerMtok: input * 1.25,
})

const shippedRate = (model: string, input: number, output: number): PriceRate => ({
  provider: "anthropic-api",
  model,
  ...rates(input, output),
})

const override = (rate: PriceRate): PriceOverride => ({
  ...rate,
  updatedAt: "2026-07-25T10:00:00.000Z",
})

describe("mergePriceRows", () => {
  const shipped = [shippedRate("claude-sonnet-5", 3, 15), shippedRate("claude-opus-4-8", 5, 25)]

  test("one row per (provider, model), ordered by provider then model", () => {
    const rows = mergePriceRows(shipped, [override({ ...shippedRate("claude-sonnet-5", 2.5, 12) })])
    expect(rows.map((row) => row.model)).toEqual(["claude-opus-4-8", "claude-sonnet-5"])
    expect(rows).toHaveLength(2)
  })

  test("an unedited shipped row reads as shipped and keeps the image's numbers", () => {
    const row = mergePriceRows(shipped, [])[0]
    expect(row?.origin).toBe("shipped")
    expect(row?.rates.inputPerMtok).toBe(5)
    expect(row?.shipped).not.toBeNull()
  })

  test("an override on a priced model reads as overridden, with the shipped rate kept beside it", () => {
    const rows = mergePriceRows(shipped, [override(shippedRate("claude-sonnet-5", 2.5, 12))])
    const row = rows.find((candidate) => candidate.model === "claude-sonnet-5")
    expect(row?.origin).toBe("overridden")
    expect(row?.rates.inputPerMtok).toBe(2.5)
    // The number it replaced stays available, which is what "reset to shipped" reverts to.
    expect(row?.shipped?.inputPerMtok).toBe(3)
    expect(row?.updatedAt).toBe("2026-07-25T10:00:00.000Z")
  })

  test("an override for a model the image does not price is an extension, not an edit", () => {
    const extension = override({ provider: "openrouter", model: "some/model", ...rates(1, 2) })
    const row = mergePriceRows(shipped, [extension]).find((candidate) => candidate.id.includes("/"))
    expect(row?.origin).toBe("added")
    // Nothing to revert to: removing it un-prices the model rather than restoring a number.
    expect(row?.shipped).toBeNull()
  })

  test("an override that restates the shipped price is not a departure from it", () => {
    const rows = mergePriceRows(shipped, [override(shippedRate("claude-sonnet-5", 3, 15))])
    const row = rows.find((candidate) => candidate.model === "claude-sonnet-5")
    expect(row?.origin).toBe("shipped")
  })
})

describe("withRates", () => {
  const shipped = [shippedRate("claude-sonnet-5", 3, 15)]

  test("editing a shipped row makes it an override", () => {
    const row = mergePriceRows(shipped, [])[0]
    expect(row === undefined ? null : withRates(row, rates(4, 20)).origin).toBe("overridden")
  })

  test("editing an override back to the shipped number makes it shipped again", () => {
    const row = mergePriceRows(shipped, [override(shippedRate("claude-sonnet-5", 9, 9))])[0]
    expect(row === undefined ? null : withRates(row, rates(3, 15)).origin).toBe("shipped")
  })
})

describe("buildPriceOverridePayload", () => {
  const shipped = [shippedRate("claude-sonnet-5", 3, 15), shippedRate("claude-opus-4-8", 5, 25)]

  test("emits the complete set — every departure from the image, in one array", () => {
    const rows = mergePriceRows(shipped, [
      override(shippedRate("claude-sonnet-5", 2.5, 12)),
      override({ provider: "openrouter", model: "some/model", ...rates(1, 2) }),
    ])
    const payload = buildPriceOverridePayload(rows)
    expect(payload.map((rate) => rate.model).sort()).toEqual(["claude-sonnet-5", "some/model"])
  })

  test("drops rows equal to shipped, so the stored table never holds a copy of the image", () => {
    const rows = mergePriceRows(shipped, [override(shippedRate("claude-sonnet-5", 3, 15))])
    expect(buildPriceOverridePayload(rows)).toEqual([])
  })

  test("a table with every override reset back to shipped sends an empty array, which clears it", () => {
    const rows = mergePriceRows(shipped, [override(shippedRate("claude-sonnet-5", 2.5, 12))]).map(
      (row) => (row.shipped === null ? row : withRates(row, row.shipped)),
    )
    expect(buildPriceOverridePayload(rows)).toHaveLength(0)
  })
})

describe("diffOverrides", () => {
  const stored = [
    override(shippedRate("claude-sonnet-5", 2.5, 12)),
    override(shippedRate("claude-opus-4-8", 4, 20)),
  ]

  test("a stored override missing from the payload is a removal", () => {
    const diff = diffOverrides(stored, [shippedRate("claude-sonnet-5", 2.5, 12)])
    expect(diff.removed.map((rate) => rate.model)).toEqual(["claude-opus-4-8"])
    expect(diff.changed).toEqual([])
  })

  test("a re-priced row is a change, an identical one is neither", () => {
    const diff = diffOverrides(stored, [
      shippedRate("claude-sonnet-5", 2.5, 12),
      shippedRate("claude-opus-4-8", 4.5, 20),
    ])
    expect(diff.changed.map((rate) => rate.model)).toEqual(["claude-opus-4-8"])
    expect(diff.removed).toEqual([])
  })

  test("an empty payload removes everything stored", () => {
    expect(diffOverrides(stored, []).removed).toHaveLength(2)
  })
})
