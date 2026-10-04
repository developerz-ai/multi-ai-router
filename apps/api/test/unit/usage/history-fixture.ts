import type {
  UsageHistoryCoverage,
  UsageHistoryRepository,
  UsageReadRepository,
} from "@multi-ai-router/db"

/** A coherent injected history view for service tests; SQL semantics have independent PG tests. */
export function historyFixture(
  raw: UsageReadRepository,
  now: Date,
  overrides: Partial<UsageHistoryCoverage> = {},
): UsageHistoryRepository {
  const history: UsageHistoryRepository = {
    coverage: async () => ({
      dbNow: now,
      earliestAt: now,
      legacy: false,
      incomplete: false,
      rawFrom: now,
      rawTo: now,
      timeBasis: "event-time",
      requestsBasis: "terminal",
      historicalPrecision: "day",
      ...overrides,
    }),
    totals: (window) => raw.totals(window),
    breakdown: (window, dimension) => raw.breakdown(window, dimension),
    series: (window, bucket) => raw.series(window, bucket),
    seriesByDimension: (window, bucket, dimension) =>
      raw.seriesByDimension(window, bucket, dimension),
    withSnapshot: (callback) => callback(history, raw),
    backfill: async () => ({ processed: 0, remaining: false }),
    rollupDay: async () => 0,
    deleteOlderThan: async () => 0,
    deleteRetainedHistory: async () => 0,
  }
  return history
}
