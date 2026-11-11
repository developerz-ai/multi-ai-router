import { expect, test } from "bun:test"
import type { UsageGroupRow, UsageGroupSeriesPoint } from "@multi-ai-router/db"
import { EMPTY_TOTALS } from "../../../src/services/usage-read/rollup"
import { groupSeries, label } from "../../../src/services/usage-read/summary-view"

function row(id: string | null): UsageGroupRow {
  return { ...EMPTY_TOTALS, id, latencyP50Ms: null, latencyP95Ms: null, routerOverheadP95Ms: null }
}

const axis = ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"]

test("grouped series match each row by id, including null ids, absent ids and non-ISO instants", () => {
  const points: UsageGroupSeriesPoint[] = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", requests: 1 },
    { id: null, at: "2026-10-02T00:00:00Z", requests: 4 },
    { id: "a", at: "2026-10-03T00:00:00.000Z", requests: 3 },
    // A duplicate instant keeps the last point, as the per-row map always did.
    { id: "a", at: "2026-10-03T00:00:00.000Z", requests: 5 },
  ]
  const rows = label(
    [row("a"), row(null), row("missing")],
    new Map([["a", "Alpha"]]),
    axis,
    groupSeries(axis, points),
  )
  expect(rows.map((r) => [r.id, r.label, r.note, r.series])).toEqual([
    ["a", "Alpha", null, [1, 0, 5]],
    [null, null, "none", [0, 4, 0]],
    ["missing", null, "deleted", [0, 0, 0]],
  ])
})

test("100 groups x 400 buckets label inside the loop budget", () => {
  const wide = Array.from({ length: 400 }, (_, i) =>
    new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
  )
  const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`)
  const points = ids.flatMap((id) => wide.map((at) => ({ id, at, requests: 1 })))
  const names = new Map(ids.map((id) => [id, id]))
  const rows = ids.map(row)
  label(rows, names, wide, groupSeries(wide, points))
  const started = performance.now()
  const labelled = label(rows, names, wide, groupSeries(wide, points))
  const elapsed = performance.now() - started
  expect(labelled.every((r) => r.series.every((n) => n === 1))).toBe(true)
  // ~96 ms per dimension before grouping; loose enough for a busy CI runner.
  expect(elapsed).toBeLessThan(20)
})
