import type {
  UsageDimension,
  UsageGroupRow,
  UsageGroupSeriesPoint,
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
  totals(window: UsageWindow): Promise<UsageTotals>
  breakdown(
    window: UsageWindow,
    dimension: UsageDimension,
    limit?: number,
  ): Promise<UsageGroupRow[]>
  series(
    window: UsageWindow,
    bucket: "hour" | "day",
    bucketWidth?: number,
  ): Promise<UsageSeriesPoint[]>
  seriesByDimension(
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageDimension,
    bucketWidth?: number,
    ids?: readonly (string | null)[],
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
