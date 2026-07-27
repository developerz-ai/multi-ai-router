import type {
  ScheduledTaskRepository,
  UsageDailyRepository,
  UsageDimension,
  UsageGroupRow,
  UsageGroupSeriesPoint,
  UsageReadRepository,
  UsageRecentRepository,
  UsageSeriesPoint,
  UsageTotals,
} from "@multi-ai-router/db"
import { type AdminResult, ok } from "../admin/result"
import { readBreakdown, readTotals } from "./aggregate"
import { buildAxis, densify } from "./axis"
import { foldFailures, type UsageFailures } from "./failures"
import { outcomesFor, type RecentQuery, type RecentView, toRecentAttemptView } from "./recent"
import { resolveWindow, type UsageWindowQuery } from "./window"

/**
 * The console's usage surface.
 *
 * **Every breakdown row is labelled here, not by the client.** The repository returns ids, and a
 * console that had to join four id lists against four other endpoints to render a table would
 * make four extra round trips to say "dev-laptops". The label sets are injected by the
 * composition root — accounts and pools come from the warm catalog, key names from a query, which
 * is unremarkable here because this is the admin plane and nothing on it has a latency budget.
 *
 * A label may be **missing on purpose**: usage rows outlive the key or account they name (revoked
 * keys are purged 30 days later, historical rows stay), so a row can reference something that no
 * longer exists. That renders as "deleted", never as a blank cell and never by dropping the row —
 * spend that happened is still spend, and hiding it would make the totals stop adding up.
 *
 * **Totals and breakdowns are stitched from rolled days plus today's raw rows** (`aggregate.ts`),
 * because raw rows expire and the rollup does not — a `lifetime` total read from raw alone would
 * quietly mean "since the retention window". The series is the one aggregate still read straight
 * from raw: its buckets can be hourly, a grain `usage_daily` does not have.
 */

export interface UsageSummary {
  readonly window: string
  readonly bucket: "hour" | "day"
  readonly from: string
  readonly to: string
  readonly totals: UsageTotals
  readonly latency: {
    readonly p50Ms: number | null
    readonly p95Ms: number | null
    readonly routerOverheadP95Ms: number | null
    readonly ttfbP95Ms: number | null
  }
  /**
   * `totals.errors` taken apart by outcome — which of `429`, `402` and `403` that error rate
   * actually was. One percentage cannot tell an operator whether to wait, to top up, or to widen a
   * scope, and those are the three answers (`failures.ts`).
   */
  readonly failures: UsageFailures
  /** Bucket starts every series is plotted against, dense — a quiet bucket is a zero, not a gap. */
  readonly axis: readonly string[]
  /** One entry per axis point, always. A bucket with no traffic is zeros, never a missing entry. */
  readonly series: readonly UsageSeriesEntry[]
  readonly byKey: readonly UsageBreakdownRow[]
  readonly byAccount: readonly UsageBreakdownRow[]
  readonly byPool: readonly UsageBreakdownRow[]
  readonly byModel: readonly UsageBreakdownRow[]
}

export interface UsageSeriesEntry {
  readonly at: string
  readonly requests: number
  readonly attempts: number
  readonly errors: number
}

export interface UsageBreakdownRow {
  readonly id: string | null
  /** Human name. `null` when the subject is gone or the dimension did not apply. */
  readonly label: string | null
  /** Why the label is absent, so the console never has to guess. */
  readonly note: "deleted" | "none" | null
  readonly totals: UsageTotals
  /** This group's percentiles. A global p95 cannot answer "which account is slow". */
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
  /** Requests per bucket, aligned to `axis`, so two rows are comparable at a glance. */
  readonly series: readonly number[]
}

/**
 * Display names for every id a breakdown can carry, read once per summary.
 *
 * Maps rather than per-id lookups: a breakdown can be hundreds of rows, and resolving each one
 * separately is how an admin screen quietly becomes N queries.
 */
export interface UsageLabelSets {
  readonly keys: ReadonlyMap<string, string>
  readonly accounts: ReadonlyMap<string, string>
  readonly pools: ReadonlyMap<string, string>
}

export interface UsageServiceDeps {
  readonly usage: UsageReadRepository
  /**
   * The raw attempt rows behind the live feed. Separate from `usage`, which only
   * aggregates: the feed asks a question no `GROUP BY` can answer — *which*
   * request failed, not how many.
   */
  readonly recent: UsageRecentRepository
  /** The rolled days. Every closed day in a window is answered from here, never by scanning raw rows. */
  readonly daily: Pick<UsageDailyRepository, "totals" | "breakdown">
  /**
   * How far the rollup has actually got. Read per summary rather than cached:
   * it changes hourly, it is one indexed row, and a stale reading here is the
   * one that would make a day of usage look like a day of silence.
   */
  readonly scheduledTasks: Pick<ScheduledTaskRepository, "lastSuccess">
  readonly labels: () => Promise<UsageLabelSets>
  readonly now: () => Date
}

export interface UsageService {
  summary(query: UsageWindowQuery): Promise<AdminResult<UsageSummary>>
  /** Individual attempts, newest first — the feed the summary cannot answer for. */
  recent(query: RecentQuery): Promise<AdminResult<RecentView>>
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  return {
    summary: async (query) => {
      // One reading of the clock for the whole summary: it resolves the window *and* decides
      // which days count as closed, and two readings could disagree across a midnight tick.
      const now = deps.now()
      const window = resolveWindow(query, now)

      // Which table answers which day depends on how far the rollup got, so this one row has to
      // land before the aggregates are issued. It rides with the labels, which need nothing.
      const [labels, lastRollup] = await Promise.all([
        deps.labels(),
        deps.scheduledTasks.lastSuccess("usage_rollup"),
      ])
      const rolledAt = lastRollup?.startedAt ?? null

      // One window, several independent aggregates: issued together rather than in sequence, so
      // the screen costs one round trip's latency instead of seven.
      const dimensions: readonly UsageDimension[] = ["apiKeyId", "accountId", "poolId", "model"]

      const [totals, latency, series, outcomes, breakdowns, groupSeries] = await Promise.all([
        readTotals(deps, window, now, rolledAt),
        deps.usage.latency(window),
        deps.usage.series(window, window.bucket),
        deps.usage.outcomes(window),
        Promise.all(dimensions.map((d) => readBreakdown(deps, window, now, rolledAt, d))),
        Promise.all(dimensions.map((d) => deps.usage.seriesByDimension(window, window.bucket, d))),
      ])

      const axis = buildAxis(window)
      const [keyRows, accountRows, poolRows, modelRows] = breakdowns
      const [keySeries, accountSeries, poolSeries, modelSeries] = groupSeries

      return ok({
        window: window.label,
        bucket: window.bucket,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        totals,
        latency,
        // Folded against the stitched total rather than its own sum, so the summary can say when
        // the window reaches past the raw rows these counts came from.
        failures: foldFailures(outcomes, totals.attempts),
        axis,
        series: alignSeries(axis, series),
        byKey: label(keyRows ?? [], labels.keys, axis, keySeries ?? []),
        byAccount: label(accountRows ?? [], labels.accounts, axis, accountSeries ?? []),
        byPool: label(poolRows ?? [], labels.pools, axis, poolSeries ?? []),
        // A model name is its own label; there is nothing to resolve and nothing to lose.
        byModel: (modelRows ?? []).map((row) => ({
          ...row2(row, axis, modelSeries ?? []),
          label: row.id,
          note: null,
        })),
      })
    },

    recent: async (query) => {
      // The label sets and the rows are independent, so they are issued together
      // rather than in sequence — the same reason the summary's aggregates are.
      const [labels, rows] = await Promise.all([
        deps.labels(),
        deps.recent.recent({
          limit: query.limit,
          outcomes: outcomesFor(query),
          requestId: query.requestId,
        }),
      ])

      // `limit` is echoed as asked for, never as `rows.length`: a quiet router
      // returning four rows has truncated nothing, and a caption reading "at
      // most 4" would be describing the traffic rather than the page.
      return ok({
        attempts: rows.map((row) => toRecentAttemptView(row, labels)),
        limit: query.limit,
      })
    },
  }
}

/**
 * Puts the summary series on the same axis every breakdown row uses.
 *
 * Without this the headline chart and the row sparklines beside it would have different lengths
 * and different x-positions for the same instant, which is the sort of thing nobody notices until
 * they are comparing two charts that disagree.
 */
function alignSeries(
  axis: readonly string[],
  points: readonly UsageSeriesPoint[],
): readonly UsageSeriesEntry[] {
  const byBucket = new Map(points.map((point) => [point.at, point]))
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

function label(
  rows: readonly UsageGroupRow[],
  names: ReadonlyMap<string, string>,
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): UsageBreakdownRow[] {
  return rows.map((row) => {
    const base = row2(row, axis, points)
    if (base.id === null) return { ...base, label: null, note: "none" }
    const found = names.get(base.id)
    return found === undefined
      ? { ...base, label: null, note: "deleted" }
      : { ...base, label: found, note: null }
  })
}

/** Separates the grouping id and percentiles from the totals, which are flat on the row. */
function row2(
  row: UsageGroupRow,
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): Omit<UsageBreakdownRow, "label" | "note"> {
  const { id, latencyP50Ms, latencyP95Ms, routerOverheadP95Ms, ...totals } = row
  const mine = new Map(
    points.filter((point) => point.id === id).map((point) => [point.at, point.requests]),
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
