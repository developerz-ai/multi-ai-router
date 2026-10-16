import type { UsageExportRow } from "./usage-export-repository"
import type {
  UsageAttributedDimension,
  UsageColumnDimension,
  UsageFilter,
  UsageGroupRow,
  UsageGroupSeriesPoint,
  UsageKeyAttribution,
  UsageReadRepository,
  UsageSeriesPoint,
  UsageTotals,
  UsageWindow,
} from "./usage-read-repository"
import type { UsageWeekRead } from "./usage-week-read"

export interface UsageHistoryCoverage {
  readonly dbNow: Date
  readonly earliestAt: Date | null
  readonly legacy: boolean
  readonly incomplete: boolean
  readonly rawFrom: Date | null
  readonly rawTo: Date | null
  readonly timeBasis: "event-time"
  readonly requestsBasis: "terminal" | "mixed-legacy"
  readonly historicalPrecision: "day"
}
export interface UsageHistoryRepository {
  /**
   * Just the database clock and the earliest retained instant, for the window-resolution step that
   * needs nothing else. A whole `coverage()` call there would run its `pending`/`legacy` checks over
   * every retained row for a result the window never reads — see docs/idea/08-observability.md.
   */
  clock(): Promise<Pick<UsageHistoryCoverage, "dbNow" | "earliestAt">>
  coverage(window?: UsageWindow): Promise<UsageHistoryCoverage>
  totals(window: UsageWindow, filter: UsageFilter): Promise<UsageTotals>
  breakdown(
    window: UsageWindow,
    dimension: UsageColumnDimension,
    limit: number | undefined,
    filter: UsageFilter,
  ): Promise<UsageGroupRow[]>
  breakdown(
    window: UsageWindow,
    dimension: UsageAttributedDimension,
    limit: number | undefined,
    filter: UsageFilter,
    attribution: UsageKeyAttribution,
  ): Promise<UsageGroupRow[]>
  series(
    window: UsageWindow,
    bucket: "hour" | "day",
    bucketWidth: number | undefined,
    filter: UsageFilter,
  ): Promise<UsageSeriesPoint[]>
  seriesByDimension(
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageColumnDimension,
    bucketWidth: number | undefined,
    ids: readonly (string | null)[] | undefined,
    filter: UsageFilter,
  ): Promise<UsageGroupSeriesPoint[]>
  seriesByDimension(
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageAttributedDimension,
    bucketWidth: number | undefined,
    ids: readonly (string | null)[] | undefined,
    filter: UsageFilter,
    attribution: UsageKeyAttribution,
  ): Promise<UsageGroupSeriesPoint[]>
  /**
   * At most `limit` rows at UTC day x key x account x pool x model for the CSV export, over the
   * same source and (required) filter as `totals`. The caller asks for `cap + 1` to learn it is
   * over the cap.
   */
  exportRows(window: UsageWindow, filter: UsageFilter, limit: number): Promise<UsageExportRow[]>
  /**
   * One whole UTC week at key x account x pool x model for the weekly report, over the same source
   * as `totals`. The window must be whole UTC days. Throws `UsageWeekRowCeilingError` when the week has
   * more than `ceiling` rows, never a truncated read.
   */
  weekRows(window: UsageWindow, ceiling: number): Promise<UsageWeekRead>
  /** All history and retained detail reads use one repeatable-read snapshot. */
  withSnapshot<T>(
    callback: (history: UsageHistoryRepository, raw: UsageReadRepository) => Promise<T>,
  ): Promise<T>
  /** Bounded exact source-era registration; never guesses legacy terminal ownership. */
  backfill(input: {
    readonly limit: number
  }): Promise<{ readonly processed: number; readonly remaining: boolean }>
  /** DB-clock closed-day reconciliation of V2 receipts only; legacy baselines are immutable. */
  rollupDay(day: Date): Promise<number>
  /** Advances the durable history horizon and purges one bounded aggregate/receipt batch. */
  deleteRetainedHistory(input: {
    readonly retentionDays: number
    readonly limit: number
  }): Promise<number>
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
}
