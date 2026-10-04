import type { UsageGroupRow, UsageGroupSeriesPoint, UsageSeriesPoint } from "@multi-ai-router/db"
import { densify } from "./axis"
import type { UsageBreakdownRow, UsageSeriesEntry } from "./types"

/**
 * Puts the summary series on the same axis every breakdown row uses.
 *
 * Without this the headline chart and the row sparklines beside it would have different lengths
 * and different x-positions for the same instant, which is the sort of thing nobody notices until
 * they are comparing two charts that disagree.
 */
export function alignSeries(
  axis: readonly string[],
  points: readonly UsageSeriesPoint[],
): readonly UsageSeriesEntry[] {
  const byBucket = new Map(points.map((point) => [new Date(point.at).toISOString(), point]))
  return axis.map((at) => {
    const found = byBucket.get(at)
    return {
      at,
      requests: found?.requests ?? 0,
      attempts: found?.attempts ?? 0,
      errors: found?.errors ?? 0,
    }
  })
}

export function label(
  rows: readonly UsageGroupRow[],
  names: ReadonlyMap<string, string>,
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): UsageBreakdownRow[] {
  return rows.map((row) => {
    const base = breakdownRow(row, axis, points)
    if (base.id === null) return { ...base, label: null, note: "none" }
    const found = names.get(base.id)
    return found === undefined
      ? { ...base, label: null, note: "deleted" }
      : { ...base, label: found, note: null }
  })
}

/**
 * Separates the grouping id and percentiles from the totals, which are flat on the row.
 *
 * **The name matters, and a digit-suffixed one is what it must never be.** A bundler renames a
 * local that collides with a hoisted binding by appending a digit, so `row` becomes `row2` — and
 * when a module-scope function is *already* called that, the minted local shadows it and the call
 * site invokes a plain object. Bundler-only: source and `bun test` are fine, every unit and
 * integration test over this file passes, and the operator console's usage dashboard still answers
 * `500` in production with `TypeError: row2 is not a function` (2026-09-06).
 * `bundle-shadowing.test.ts` is the guard; a name no bundler mints is the fix.
 */
export function breakdownRow(
  row: UsageGroupRow,
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): Omit<UsageBreakdownRow, "label" | "note"> {
  const { id, latencyP50Ms, latencyP95Ms, routerOverheadP95Ms, ...totals } = row
  const mine = new Map(
    points
      .filter((point) => point.id === id)
      .map((point) => [new Date(point.at).toISOString(), point.requests]),
  )
  return {
    id,
    totals,
    latencyP50Ms,
    latencyP95Ms,
    routerOverheadP95Ms,
    series: densify(axis, mine),
  }
}
