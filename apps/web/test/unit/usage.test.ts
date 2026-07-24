import { describe, expect, test } from "bun:test"
import {
  breakdownFor,
  EMPTY_TOTALS,
  fetchUsageSummary,
  sumTotals,
  USAGE_DIMENSIONS,
  USAGE_IS_PLACEHOLDER,
  USAGE_WINDOWS,
  usageDimensionLabel,
  usageWindowLabel,
} from "../../src/lib/api/usage"

// These figures are generated, not measured — see the banner at the top of
// `lib/api/usage.ts`. What is worth testing is the *contract* the console
// renders against, because that contract is what the real endpoint has to
// honour when it lands.

describe("the placeholder contract", () => {
  test("every summary declares itself as placeholder data", async () => {
    expect(USAGE_IS_PLACEHOLDER).toBe(true)
    const summary = await fetchUsageSummary("7d")
    expect(summary.placeholder).toBe(true)
  })

  test("the series has one point per bucket in the window", async () => {
    const today = await fetchUsageSummary("today")
    expect(today.bucket).toBe("hour")
    expect(today.series).toHaveLength(24)

    const week = await fetchUsageSummary("7d")
    expect(week.bucket).toBe("day")
    expect(week.series).toHaveLength(7)
  })

  test("every breakdown row's sparkline matches the series length", async () => {
    const summary = await fetchUsageSummary("30d")
    for (const dimension of USAGE_DIMENSIONS) {
      for (const row of breakdownFor(summary, dimension)) {
        expect(row.series).toHaveLength(summary.series.length)
      }
    }
  })

  test("is deterministic — a re-render never reshuffles the numbers", async () => {
    const first = await fetchUsageSummary("7d")
    const second = await fetchUsageSummary("7d")
    expect(second.totals.requests).toBe(first.totals.requests)
    expect(second.byKey.map((row) => row.totals.requests)).toEqual(
      first.byKey.map((row) => row.totals.requests),
    )
  })

  test("attempts are never fewer than requests — a chain is one request, many attempts", async () => {
    const summary = await fetchUsageSummary("7d")
    expect(summary.totals.attempts).toBeGreaterThanOrEqual(summary.totals.requests)
  })

  test("every window and dimension has a label", () => {
    for (const window of USAGE_WINDOWS) expect(usageWindowLabel(window).length).toBeGreaterThan(0)
    for (const dimension of USAGE_DIMENSIONS) {
      expect(usageDimensionLabel(dimension).length).toBeGreaterThan(0)
    }
  })
})

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
    expect(total.costMetered).toBe(3)
    expect(total.costNotional).toBe(8)
  })
})
