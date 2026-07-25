import { describe, expect, test } from "bun:test"
import { EMPTY_TOTALS, type UsageBreakdownRow, type UsageTotals } from "../../src/lib/api/usage"
import {
  indexUsage,
  NO_USAGE,
  shareOf,
  TOP_N_MEASURES,
  topN,
  topNMeasureLabel,
  topNMeasureValue,
  usageFor,
} from "../../src/lib/usage-index"

/**
 * The join and the ranking, pinned.
 *
 * Two properties are worth more than the rest here. A member with no traffic must read as a zero
 * and never as a blank, because a blank cell is how a broken join looks. And a ranking must be on
 * one measure only: metered spend is billed money, notional spend is an attribution against a
 * flat-fee subscription, and any function that added them would produce a figure no invoice will
 * ever match. The last block below is that gate.
 */

function row(
  id: string,
  totals: Partial<UsageTotals> = {},
  series: readonly number[] = [],
): UsageBreakdownRow {
  return { id, label: id, note: "", series, totals: { ...EMPTY_TOTALS, ...totals } }
}

describe("indexUsage", () => {
  test("carries every measure a cell needs, keyed by member id", () => {
    const rows = [
      row("key-a", { requests: 12, errors: 2, costMetered: 3.5, costNotional: 9 }, [1, 2, 3]),
      row("key-b", { requests: 4 }),
    ]

    const index = indexUsage(rows)

    expect(index.size).toBe(2)
    expect(usageFor(index, "key-a")).toEqual({
      requests: 12,
      costMetered: 3.5,
      costNotional: 9,
      errors: 2,
      series: [1, 2, 3],
    })
    expect(usageFor(index, "key-b").requests).toBe(4)
  })

  test("an empty breakdown indexes to an empty map, not to a throw", () => {
    expect(indexUsage([]).size).toBe(0)
  })
})

describe("usageFor", () => {
  test("a member with no rows in the window is zero, never undefined", () => {
    const index = indexUsage([row("key-a", { requests: 1 })])

    const missing = usageFor(index, "key-never-used")

    expect(missing).toBeDefined()
    expect(missing).toBe(NO_USAGE)
    expect(missing.requests).toBe(0)
    expect(missing.costMetered).toBe(0)
    expect(missing.costNotional).toBe(0)
    expect(missing.errors).toBe(0)
    expect(missing.series).toEqual([])
  })
})

describe("topN", () => {
  const rows = [
    row("a", { requests: 5, errors: 1, costMetered: 0.5, costNotional: 40 }),
    row("b", { requests: 30, errors: 9, costMetered: 0.1, costNotional: 1 }),
    row("c", { requests: 12, errors: 4, costMetered: 7, costNotional: 0 }),
  ]

  test("ranks on requests, descending", () => {
    expect(topN(rows, "requests", 3).map((r) => r.id)).toEqual(["b", "c", "a"])
  })

  test("ranks on errors, descending", () => {
    expect(topN(rows, "errors", 3).map((r) => r.id)).toEqual(["b", "c", "a"])
  })

  test("ranks on metered spend, descending — a different order from requests", () => {
    expect(topN(rows, "costMetered", 3).map((r) => r.id)).toEqual(["c", "a", "b"])
  })

  test("ranks on notional spend, descending — its own order again", () => {
    expect(topN(rows, "costNotional", 3).map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  test("ties break on requests, then on id, so the order never wobbles between renders", () => {
    const tied = [
      row("zeta", { requests: 4, costMetered: 2 }),
      row("alpha", { requests: 4, costMetered: 2 }),
      row("mid", { requests: 9, costMetered: 2 }),
    ]

    expect(topN(tied, "costMetered", 3).map((r) => r.id)).toEqual(["mid", "alpha", "zeta"])
    expect(topN([...tied].reverse(), "costMetered", 3).map((r) => r.id)).toEqual([
      "mid",
      "alpha",
      "zeta",
    ])
  })

  test("limit clamps to the top of the ranking", () => {
    expect(topN(rows, "requests", 2).map((r) => r.id)).toEqual(["b", "c"])
  })

  test("a limit past the end returns what there is", () => {
    expect(topN(rows, "requests", 99)).toHaveLength(3)
  })

  test("a limit of zero or less is an empty leaderboard, not the whole list", () => {
    expect(topN(rows, "requests", 0)).toEqual([])
    expect(topN(rows, "requests", -3)).toEqual([])
  })

  test("does not reorder the caller's array — it is shared query state", () => {
    const original = [...rows]

    topN(rows, "costMetered", 3)

    expect(rows.map((r) => r.id)).toEqual(original.map((r) => r.id))
  })
})

describe("shareOf", () => {
  test("is the member's part of that one column", () => {
    const quiet = row("a", { requests: 25 })
    const busy = row("b", { requests: 75 })

    expect(shareOf([quiet, busy], quiet, "requests")).toBeCloseTo(0.25, 10)
    expect(shareOf([quiet, busy], busy, "requests")).toBeCloseTo(0.75, 10)
  })

  test("a zero column total is a zero share, never NaN", () => {
    const idle = row("a")
    const rows = [idle, row("b")]

    for (const measure of TOP_N_MEASURES) {
      const share = shareOf(rows, idle, measure)
      expect(Number.isNaN(share)).toBe(false)
      expect(share).toBe(0)
    }
  })

  test("an empty set has nothing to divide by and still answers zero", () => {
    expect(shareOf([], row("ghost", { requests: 5 }), "requests")).toBe(0)
  })
})

describe("metered and notional are never summed", () => {
  // A subscription account is all attribution and no billed money; an API key is the reverse.
  const subscription = row("subscription", { requests: 100, costMetered: 0, costNotional: 900 })
  const apiKey = row("api-key", { requests: 1, costMetered: 12, costNotional: 0 })
  const rows = [subscription, apiKey]

  test("a huge notional spend ranks last on metered spend", () => {
    expect(topN(rows, "costMetered", 2).map((r) => r.id)).toEqual(["api-key", "subscription"])
    expect(topN(rows, "costNotional", 2).map((r) => r.id)).toEqual(["subscription", "api-key"])
  })

  test("a metered share ignores notional spend entirely, and the reverse", () => {
    expect(shareOf(rows, apiKey, "costMetered")).toBe(1)
    expect(shareOf(rows, subscription, "costMetered")).toBe(0)
    expect(shareOf(rows, subscription, "costNotional")).toBe(1)
    expect(shareOf(rows, apiKey, "costNotional")).toBe(0)
  })

  test("no measure ever reads back the two costs added together", () => {
    const mixed = row("mixed", { costMetered: 3, costNotional: 7 })

    for (const measure of TOP_N_MEASURES) {
      // 10 is the forbidden number: a combined "total cost" nobody was ever billed.
      expect(topNMeasureValue(mixed, measure)).not.toBe(10)
    }
    expect(topNMeasureValue(mixed, "costMetered")).toBe(3)
    expect(topNMeasureValue(mixed, "costNotional")).toBe(7)
  })

  test("the two costs are separate, differently named choices in the switcher", () => {
    expect(TOP_N_MEASURES).toContain("costMetered")
    expect(TOP_N_MEASURES).toContain("costNotional")

    const labels = TOP_N_MEASURES.map(topNMeasureLabel)
    expect(new Set(labels).size).toBe(TOP_N_MEASURES.length)
    for (const label of labels) expect(label.length).toBeGreaterThan(0)
  })
})
