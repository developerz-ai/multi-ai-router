import type { Database } from "../client"
import { createUsageHistoryRepository } from "./usage-history-repository"
import type { UsageDimension, UsageTotals } from "./usage-read-repository"

export interface UsageDayRange {
  readonly fromDay: string
  readonly toDay: string
}
export interface UsageDailyGroupRow extends UsageTotals {
  readonly id: string | null
}
export interface UsageDailyRepository {
  rollupDay(day: Date): Promise<number>
  /** History horizon retention: purges banked baseline, V2 aggregates and receipts, never raw detail. */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
  totals(range: UsageDayRange): Promise<UsageTotals>
  breakdown(range: UsageDayRange, dimension: UsageDimension): Promise<UsageDailyGroupRow[]>
}
export function toUtcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}
export function startOfUtcDay(at: Date): Date {
  return new Date(`${toUtcDay(at)}T00:00:00Z`)
}
export function startOfNextUtcDay(at: Date): Date {
  return new Date(startOfUtcDay(at).getTime() + 86400000)
}
/** Compatibility reader; legacy banked groups are immutable and never reconstructed from raw. */
export function createUsageDailyRepository(db: Database): UsageDailyRepository {
  const history = createUsageHistoryRepository(db)
  const window = (range: UsageDayRange) => ({
    from: new Date(`${range.fromDay}T00:00:00Z`),
    to: new Date(`${range.toDay}T00:00:00Z`),
  })
  return {
    rollupDay: history.rollupDay,
    totals: (range) => history.totals(window(range)),
    breakdown: (range, dimension) => history.breakdown(window(range), dimension),
    deleteOlderThan: history.deleteOlderThan,
  }
}
