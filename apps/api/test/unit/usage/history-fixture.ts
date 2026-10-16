import type {
  UsageDimension,
  UsageFilter,
  UsageHistoryCoverage,
  UsageHistoryRepository,
  UsageKeyAttribution,
  UsageReadRepository,
  UsageWindow,
} from "@multi-ai-router/db"

/** A coherent injected history view for service tests; SQL semantics have independent PG tests. */
export function historyFixture(
  raw: UsageReadRepository,
  now: Date,
  overrides: Partial<UsageHistoryCoverage> = {},
): UsageHistoryRepository {
  // Typed explicitly (not contextually from the overloaded interface) and forwarding everything the
  // raw repository can take: filter, limit and attribution. The raw API has no id list on the
  // history side, so `ids` has nowhere to go.
  const breakdown = (
    window: UsageWindow,
    dimension: UsageDimension,
    limit: number | undefined,
    filter: UsageFilter,
    attribution?: UsageKeyAttribution,
  ) =>
    dimension === "owner" || dimension === "tool"
      ? attribution === undefined
        ? Promise.reject(new Error("owner/tool requires a key attribution"))
        : raw.breakdown(window, dimension, undefined, limit, filter, attribution)
      : raw.breakdown(window, dimension, undefined, limit, filter)
  const seriesByDimension = (
    window: UsageWindow,
    bucket: "hour" | "day",
    dimension: UsageDimension,
    _width: number | undefined,
    _ids: readonly (string | null)[] | undefined,
    filter: UsageFilter,
    attribution?: UsageKeyAttribution,
  ) =>
    dimension === "owner" || dimension === "tool"
      ? attribution === undefined
        ? Promise.reject(new Error("owner/tool requires a key attribution"))
        : raw.seriesByDimension(window, bucket, dimension, filter, attribution)
      : raw.seriesByDimension(window, bucket, dimension, filter)
  const history: UsageHistoryRepository = {
    clock: async () => {
      const c = await history.coverage()
      return { dbNow: c.dbNow, earliestAt: c.earliestAt }
    },
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
    totals: (window, filter) => raw.totals(window, filter),
    breakdown,
    series: (window, bucket, _width, filter) => raw.series(window, bucket, filter),
    seriesByDimension,
    exportRows: async () => [],
    withSnapshot: (callback) => callback(history, raw),
    backfill: async () => ({ processed: 0, remaining: false }),
    rollupDay: async () => 0,
    deleteOlderThan: async () => 0,
    deleteRetainedHistory: async () => 0,
  }
  return history
}
