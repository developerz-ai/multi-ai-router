import type { UsageBreakdownRow } from "./api/usage"

// Joining usage onto another table, and ranking one measure at a time. Pure: no
// DOM, no clock, no fetch.
//
// Both jobs live here because both exist for the same reason. A breakdown
// arrives as a flat list keyed by member id, and every surface that wants usage
// beside something else — a keys table, an accounts table, a leaderboard — has
// to answer "what did *this* member do" without rescanning the list per row.
//
// The load-bearing rule is the one the cost model rests on: **metered and
// notional spend are separate measures and are never added.** Metered is real
// money from a priced model. Notional is attributed spend on a flat-fee
// subscription — what the traffic would have cost on the API, which nobody was
// billed for. Summing them invents a bill, so a ranking takes exactly one
// measure and the caller must name it. There is deliberately no function here
// that returns a combined cost, and adding one would be the bug this module
// exists to prevent.

/** One row's usage, ready for a table cell. */
export interface UsageRowSummary {
  readonly requests: number
  readonly costMetered: number
  readonly costNotional: number
  readonly errors: number
  readonly series: readonly number[]
}

/** The zero row. Returned for a member with no traffic in the window — never `undefined`. */
export const NO_USAGE: UsageRowSummary = {
  requests: 0,
  costMetered: 0,
  costNotional: 0,
  errors: 0,
  series: [],
}

/** Index a breakdown by member id, for joining usage onto a keys or accounts table. */
export function indexUsage(
  rows: readonly UsageBreakdownRow[],
): ReadonlyMap<string, UsageRowSummary> {
  const index = new Map<string, UsageRowSummary>()
  for (const row of rows) {
    index.set(row.id, {
      requests: row.totals.requests,
      costMetered: row.totals.costMetered,
      costNotional: row.totals.costNotional,
      errors: row.totals.errors,
      series: row.series,
    })
  }
  return index
}

/**
 * Never `undefined`: a member with no rows in the window really did serve zero,
 * and a cell reading `—` where the honest answer is `0` reads as a broken join.
 */
export function usageFor(index: ReadonlyMap<string, UsageRowSummary>, id: string): UsageRowSummary {
  return index.get(id) ?? NO_USAGE
}

export type TopNMeasure = "requests" | "costMetered" | "costNotional" | "errors"

/** Every measure a leaderboard can rank by, in the order a switcher offers them. */
export const TOP_N_MEASURES = [
  "requests",
  "costMetered",
  "costNotional",
  "errors",
] as const satisfies readonly TopNMeasure[]

/**
 * The one place a measure becomes a number. A `switch` with no `default` so a
 * fifth measure fails the build here instead of silently ranking as zero, and so
 * no caller reaches a total by an index keyed on a string it got from elsewhere.
 */
export function topNMeasureValue(row: UsageBreakdownRow, measure: TopNMeasure): number {
  switch (measure) {
    case "requests":
      return row.totals.requests
    case "costMetered":
      return row.totals.costMetered
    case "costNotional":
      return row.totals.costNotional
    case "errors":
      return row.totals.errors
  }
}

export function topNMeasureLabel(measure: TopNMeasure): string {
  switch (measure) {
    case "requests":
      return "Requests"
    case "costMetered":
      return "Metered spend"
    case "costNotional":
      return "Notional spend"
    case "errors":
      return "Errors"
  }
}

/** Rows ranked by one measure, descending, ties broken by requests then id for stability. */
export function topN(
  rows: readonly UsageBreakdownRow[],
  measure: TopNMeasure,
  limit: number,
): readonly UsageBreakdownRow[] {
  if (limit <= 0) return []
  // Copied before sorting: the caller's array is query cache state, and sorting
  // it in place would reorder every other view of the same breakdown.
  return [...rows].sort((a, b) => compare(a, b, measure)).slice(0, limit)
}

/**
 * Ties are broken all the way down to the id so the same input always produces
 * the same order. A leaderboard whose rows swap places between renders because
 * two members drew level is read as data changing when nothing changed.
 */
function compare(a: UsageBreakdownRow, b: UsageBreakdownRow, measure: TopNMeasure): number {
  const byMeasure = topNMeasureValue(b, measure) - topNMeasureValue(a, measure)
  if (byMeasure !== 0) return byMeasure

  const byRequests = b.totals.requests - a.totals.requests
  if (byRequests !== 0) return byRequests

  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/**
 * A member's share of the column total, `0..1`. `0` when the column total is 0 —
 * never NaN, because a share bar sized by NaN renders as a full bar, which is
 * the most misleading thing an empty window could show.
 *
 * The denominator is that one measure's column and nothing else: a share of
 * metered spend is never diluted by notional spend.
 */
export function shareOf(
  rows: readonly UsageBreakdownRow[],
  row: UsageBreakdownRow,
  measure: TopNMeasure,
): number {
  const total = rows.reduce((sum, candidate) => sum + topNMeasureValue(candidate, measure), 0)
  if (total <= 0) return 0

  // Clamped, so a row passed in from outside `rows` cannot draw past the track.
  return Math.min(1, Math.max(0, topNMeasureValue(row, measure) / total))
}
