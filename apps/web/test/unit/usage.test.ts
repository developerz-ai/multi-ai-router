import { describe, expect, test } from "bun:test"
import {
  breakdownFor,
  EMPTY_TOTALS,
  sumTotals,
  USAGE_DIMENSIONS,
  USAGE_WINDOWS,
  usageDimensionLabel,
  usageWindowLabel,
} from "../../src/lib/api/usage"

/**
 * The usage module's contract with the screens that render it.
 *
 * Parsing the wire is covered end to end against a real database on the API side. What is worth
 * pinning here is the arithmetic the console does *after* the wire, because that is the part that
 * can quietly produce a number nobody measured.
 */

describe("sumTotals", () => {
  test("an empty set sums to zero rather than to undefined", () => {
    expect(sumTotals([])).toEqual(EMPTY_TOTALS)
  })

  test("counts add and percentiles do not — an aggregate p95 is not a sum of p95s", () => {
    const row = (requests: number, p95: number) => ({
      id: String(requests),
      label: "x",
      note: "",
      series: [requests],
      totals: { ...EMPTY_TOTALS, requests, latencyP95Ms: p95 },
    })

    const total = sumTotals([row(10, 900), row(5, 2100)])
    expect(total.requests).toBe(15)
    // The maximum is the only honest summary available without the raw distribution.
    expect(total.latencyP95Ms).toBe(2100)
  })

  test("metered and notional stay apart", () => {
    const row = {
      id: "a",
      label: "a",
      note: "",
      series: [],
      totals: { ...EMPTY_TOTALS, costMetered: 1.5, costNotional: 4 },
    }
    const total = sumTotals([row, row])
    // A subscription account has no per-token price, only an attribution, so one merged "cost"
    // would be a number with no meaning.
    expect(total.costMetered).toBe(3)
    expect(total.costNotional).toBe(8)
  })
})

describe("breakdownFor", () => {
  test("selects the dimension the table is showing", () => {
    const row = { id: "a", label: "a", note: "", series: [], totals: EMPTY_TOTALS }
    const summary = {
      byKey: [row],
      byAccount: [row, row],
      byPool: [],
      byModel: [row, row, row],
    } as never

    expect(breakdownFor(summary, "key")).toHaveLength(1)
    expect(breakdownFor(summary, "account")).toHaveLength(2)
    expect(breakdownFor(summary, "pool")).toHaveLength(0)
    expect(breakdownFor(summary, "model")).toHaveLength(3)
  })
})

describe("labels", () => {
  test("every window and dimension has one, so no control renders a raw key", () => {
    for (const window of USAGE_WINDOWS) expect(usageWindowLabel(window).length).toBeGreaterThan(0)
    for (const dimension of USAGE_DIMENSIONS) {
      expect(usageDimensionLabel(dimension).length).toBeGreaterThan(0)
    }
  })
})
