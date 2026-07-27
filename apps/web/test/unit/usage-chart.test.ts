import { describe, expect, test } from "bun:test"
import type { UsageChartPoint } from "../../src/lib/api/usage"
import {
  buildChartSeries,
  CHART_SERIES_KEYS,
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  pickChartTicks,
} from "../../src/lib/usage-chart"

/**
 * The geometry `UsageChart` draws from, pinned here so a scaling or ticking regression fails a
 * unit test rather than only showing up as a visually wrong chart.
 */

function point(at: string, requests: number, attempts: number, errors: number): UsageChartPoint {
  return { at, requests, attempts, errors }
}

describe("buildChartSeries", () => {
  test("an empty window draws three empty paths, not a crash", () => {
    const series = buildChartSeries([])
    expect(series.map((entry) => entry.key)).toEqual([...CHART_SERIES_KEYS])
    for (const entry of series) expect(entry.path).toBe("")
  })

  test("a single bucket draws a flat line across the full width", () => {
    const series = buildChartSeries([point("2026-01-01T00:00:00Z", 10, 12, 1)])
    const requests = series.find((entry) => entry.key === "requests")
    expect(requests?.path).toContain(`H${CHART_VIEW_WIDTH}`)
  })

  test("all three series share one scale, so the largest value pins the top", () => {
    // requests peaks at 100, attempts at 10 — on a shared scale, attempts never reaches the top.
    const points = [point("t0", 100, 10, 0), point("t1", 0, 0, 0)]
    const series = buildChartSeries(points)
    const requests = series.find((entry) => entry.key === "requests")
    // The first requests point (value 100, the window max) sits at y=0 — the very top of the
    // view box — because the shared scale is built from the max across every series.
    expect(requests?.path.startsWith(`M0.00 0.00`)).toBe(true)
  })

  test("a quiet window (every value zero) does not divide by zero", () => {
    const points = [point("t0", 0, 0, 0), point("t1", 0, 0, 0)]
    const series = buildChartSeries(points)
    for (const entry of series) {
      expect(entry.path).not.toContain("NaN")
      expect(entry.path).toContain(`${CHART_VIEW_HEIGHT.toFixed(2)}`)
    }
  })
})

describe("pickChartTicks", () => {
  test("no points, no ticks", () => {
    expect(pickChartTicks([])).toEqual([])
  })

  test("one point is its own only tick", () => {
    const ticks = pickChartTicks([point("t0", 1, 1, 0)])
    expect(ticks).toEqual([{ index: 0, at: "t0" }])
  })

  test("two points are first and last, never collapsed to one", () => {
    const points = [point("t0", 1, 1, 0), point("t1", 2, 2, 0)]
    expect(pickChartTicks(points)).toEqual([
      { index: 0, at: "t0" },
      { index: 1, at: "t1" },
    ])
  })

  test("many points reduce to first, middle and last — never one label per bucket", () => {
    const points = Array.from({ length: 30 }, (_, index) => point(`t${index}`, index, index, 0))
    const ticks = pickChartTicks(points)
    expect(ticks).toHaveLength(3)
    expect(ticks[0]).toEqual({ index: 0, at: "t0" })
    expect(ticks[2]).toEqual({ index: 29, at: "t29" })
  })
})
