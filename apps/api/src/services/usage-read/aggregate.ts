import type {
  UsageDailyRepository,
  UsageDimension,
  UsageGroupRow,
  UsageReadRepository,
  UsageTotals,
  UsageWindow,
} from "@multi-ai-router/db"
import { mergeGroupRows, splitWindow, sumTotals } from "./rollup"

/**
 * The two-table read: `usage_daily` for closed days, `usage_records` for the edges.
 *
 * Separate from `rollup.ts`, which decides *what* to ask for and how to add the
 * answers up without touching a database. This module only issues the queries
 * the split calls for and stitches the results — one reason to change each.
 *
 * Every slice of one summary is issued concurrently and the service issues the
 * summaries concurrently too, so a window costs one round trip's latency however
 * many pieces it is cut into. That is affordable because this is the admin
 * plane; nothing here is on the request path.
 *
 * One asymmetry to know about before it looks like a bug: the rollup skips
 * attempts that never reached an account — nothing in scope, auth refused —
 * because its grain is keyed on a key *and* an account. Raw rows keep them. So a
 * window wide enough to have closed days counts those attempts for today and not
 * for the days behind it. The same thing happens to a key or account that is
 * later deleted: `ON DELETE SET NULL` strips the attribution off its raw rows,
 * while the days already rolled keep their totals under the old id — which is
 * the behaviour the console's "deleted" row exists to render, and the reason
 * spend that happened stays visible.
 */

export interface UsageAggregateSources {
  /** Raw rows: the partial edges of the window, and everything percentile-shaped. */
  readonly usage: Pick<UsageReadRepository, "totals" | "breakdown">
  /** Rolled days: the only source that still has numbers for days raw rows no longer cover. */
  readonly daily: Pick<UsageDailyRepository, "totals" | "breakdown">
}

export async function readTotals(
  sources: UsageAggregateSources,
  window: UsageWindow,
  now: Date,
  lastRollupAt: Date | null,
): Promise<UsageTotals> {
  const split = splitWindow(window, now, lastRollupAt)

  const parts = await Promise.all([
    ...split.rawSlices.map((slice) => sources.usage.totals(slice)),
    ...(split.closedDays === null ? [] : [sources.daily.totals(split.closedDays)]),
  ])
  return sumTotals(parts)
}

/**
 * One dimension's rows, totals stitched across both tables.
 *
 * **Latency stays a raw read over the whole window, deliberately.** Percentiles
 * are not summable — a p95 of two p95s is not a p95 of anything — and
 * `usage_daily` carries no latency columns for exactly that reason. So the
 * choice is between a figure computed from the raw rows that still exist and a
 * figure invented from the ones that do not, and the first is the only honest
 * one. A row that exists only in the rollup, on a day raw rows no longer cover,
 * reports `null` rather than borrowing a neighbour's number.
 *
 * The consequence worth being clear about: this read is what still scans raw
 * rows across a long window. What the split fixes here is *correctness* — a
 * `lifetime` breakdown that stops at the retention window is wrong, and now is
 * not — not the scan. Serving a 30-day chart entirely from rolled rows needs a
 * rolled series and a decision about where latency lives, which is a schema
 * question and not this one.
 */
export async function readBreakdown(
  sources: UsageAggregateSources,
  window: UsageWindow,
  now: Date,
  lastRollupAt: Date | null,
  dimension: UsageDimension,
): Promise<UsageGroupRow[]> {
  const split = splitWindow(window, now, lastRollupAt)

  // Nothing closed — "today", a window inside one UTC day, or a rollup that has
  // not caught up. The single raw read over the whole window already *is* the
  // answer, totals included.
  if (split.closedDays === null) return sources.usage.breakdown(window, dimension)

  const [latency, closed, edges] = await Promise.all([
    sources.usage.breakdown(window, dimension),
    sources.daily.breakdown(split.closedDays, dimension),
    Promise.all(split.rawSlices.map((slice) => sources.usage.breakdown(slice, dimension))),
  ])

  const percentiles = new Map(latency.map((row) => [row.id, row]))
  return mergeGroupRows([closed, ...edges]).map((row) => {
    const measured = percentiles.get(row.id)
    return {
      ...row,
      latencyP50Ms: measured?.latencyP50Ms ?? null,
      latencyP95Ms: measured?.latencyP95Ms ?? null,
      routerOverheadP95Ms: measured?.routerOverheadP95Ms ?? null,
    }
  })
}
