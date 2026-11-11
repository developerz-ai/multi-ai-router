import type { UsageGroupRow, UsageGroupSeriesPoint, UsageSeriesPoint } from "@multi-ai-router/db"
import type { KeyLabel, UsageBreakdownRow, UsageSeriesEntry } from "./types"

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

/** Projects the loader's richer key entries to the display name the wire shape carries. */
export function keyNames(keys: ReadonlyMap<string, KeyLabel>): ReadonlyMap<string, string> {
  return new Map([...keys].map(([id, key]) => [id, key.name]))
}

/** One dimension's series, already densified onto the axis, keyed by row id. */
export type GroupedSeries = ReadonlyMap<string | null, readonly number[]>

/**
 * Places a dimension's series points on the axis once, so labelling a breakdown is
 * O(rows + points) rather than every row re-scanning every point (100 rows x 400 buckets cost
 * ~96 ms per dimension on the loop that also relays streams). The query already emits ISO
 * instants; each distinct `at` is still normalised once so a differently formatted instant lands
 * on its bucket. A point off the axis is dropped and a duplicate instant keeps the last point,
 * exactly as `densify` does.
 */
export function groupSeries(
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): GroupedSeries {
  const slot = new Map(axis.map((at, index) => [at, index]))
  const slotOf = new Map<string, number | undefined>()
  const grouped = new Map<string | null, number[]>()
  for (const point of points) {
    let index = slotOf.get(point.at)
    if (!slotOf.has(point.at)) {
      index = slot.get(new Date(point.at).toISOString())
      slotOf.set(point.at, index)
    }
    if (index === undefined) continue
    let mine = grouped.get(point.id)
    if (mine === undefined) {
      mine = new Array<number>(axis.length).fill(0)
      grouped.set(point.id, mine)
    }
    mine[index] = point.requests
  }
  return grouped
}

export function label(
  rows: readonly UsageGroupRow[],
  names: ReadonlyMap<string, string>,
  axis: readonly string[],
  series: GroupedSeries,
): UsageBreakdownRow[] {
  return rows.map((row) => {
    const base = breakdownRow(row, axis, series)
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
  series: GroupedSeries,
): Omit<UsageBreakdownRow, "label" | "note"> {
  const { id, latencyP50Ms, latencyP95Ms, routerOverheadP95Ms, ...totals } = row
  return {
    id,
    totals,
    latencyP50Ms,
    latencyP95Ms,
    routerOverheadP95Ms,
    series: series.get(id) ?? axis.map(() => 0),
  }
}
