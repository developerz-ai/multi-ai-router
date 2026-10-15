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
