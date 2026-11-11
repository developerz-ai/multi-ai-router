import { describe, expect, test } from "bun:test"
import type { ProviderId } from "@multi-ai-router/core"
import type { PriceRow } from "../../src/lib/api/settings"
import { filterPriceRows, PRICE_PAGE_SIZE, visiblePriceRows } from "../../src/lib/price-filter"

function row(provider: ProviderId, model: string): PriceRow {
  return {
    id: `${provider}/${model}`,
    provider,
    model,
    origin: "shipped",
    shipped: null,
    rates: { inputPerMtok: 1, outputPerMtok: 2, cacheReadPerMtok: 0, cacheWritePerMtok: 0 },
    longContext: null,
    updatedAt: null,
  }
}

const rows = Array.from({ length: 40 }, (_, i) =>
  row(i % 2 === 0 ? "anthropic-api" : "openrouter", `model-${String(i).padStart(2, "0")}`),
)

describe("filterPriceRows", () => {
  test("matches model or provider, case-insensitively; blank matches all", () => {
    expect(filterPriceRows(rows, "").length).toBe(40)
    expect(filterPriceRows(rows, "MODEL-0").length).toBe(10)
    expect(filterPriceRows(rows, "openrouter").length).toBe(20)
    expect(filterPriceRows(rows, "nothing-here").length).toBe(0)
  })
})

describe("visiblePriceRows", () => {
  test("folds to the first page by default and says how many it hid", () => {
    const visible = visiblePriceRows(rows, "", false, () => false)
    expect(visible.rows.length).toBe(PRICE_PAGE_SIZE)
    expect(visible.hidden).toBe(40 - PRICE_PAGE_SIZE)
    expect(visible.matched).toBe(40)
  })

  test("a search or show-all unfolds", () => {
    expect(visiblePriceRows(rows, "openrouter", false, () => false).hidden).toBe(0)
    expect(visiblePriceRows(rows, "", true, () => false).rows.length).toBe(40)
  })

  test("an edited row past the fold stays visible", () => {
    const edited = rows[39]
    const visible = visiblePriceRows(rows, "", false, (r) => r.id === edited?.id)
    expect(visible.rows.some((r) => r.id === edited?.id)).toBe(true)
    expect(visible.rows.length).toBe(PRICE_PAGE_SIZE + 1)
    expect(visible.hidden).toBe(40 - PRICE_PAGE_SIZE - 1)
  })

  test("a table that fits is never folded", () => {
    expect(visiblePriceRows(rows.slice(0, 10), "", false, () => false).hidden).toBe(0)
  })
})
