import type {
  UsageColumnDimension,
  UsageDimension,
  UsageFilter,
  UsageHistoryCoverage,
  UsageHistoryRepository,
  UsageKeyAttribution,
  UsageReadRepository,
  UsageSummaryAggregates,
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
  const unpriced = { attempts: null, since: "infinity" }
  const breakdown = async (
    window: UsageWindow,
    dimension: UsageDimension,
    limit: number | undefined,
    filter: UsageFilter,
    attribution?: UsageKeyAttribution,
  ) => {
    const rows =
      dimension === "owner" || dimension === "tool"
        ? attribution === undefined
          ? Promise.reject(new Error("owner/tool requires a key attribution"))
          : raw.breakdown(window, dimension, undefined, limit, filter, attribution)
        : raw.breakdown(window, dimension, undefined, limit, filter)
    return (await rows).map((row) => ({ ...row, unpriced }))
  }
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
    totals: async (window, filter) => ({ ...(await raw.totals(window, filter)), unpriced }),
    breakdown,
    summaryAggregates: (window, limit, filter, attribution) =>
      composedAggregates(history, window, limit, filter, attribution),
    series: (window, bucket, _width, filter) => raw.series(window, bucket, filter),
    seriesByDimension,
    exportRows: async () => [],
    weekRows: async () => {
      throw new Error("history fixture does not serve weekly reports")
    },
    withSnapshot: (callback) => callback(history, raw),
    backfill: async () => ({ processed: 0, remaining: false }),
    rollupDay: async () => 0,
    deleteOlderThan: async () => 0,
    deleteRetainedHistory: async () => 0,
  }
  return history
}

const COLUMN_DIMENSIONS: readonly UsageColumnDimension[] = [
  "apiKeyId",
  "accountId",
  "poolId",
  "model",
]

/**
 * `summaryAggregates` as the seven separate reads it replaces, read through `history` at call time
 * so a test that overrides `totals` or `breakdown` sees the override. The SQL equivalence itself is
 * packages/db's differential test (`usage-history-summary.test.ts`).
 */
export async function composedAggregates(
  history: Pick<UsageHistoryRepository, "totals" | "breakdown">,
  window: UsageWindow,
  limit: number,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
): Promise<UsageSummaryAggregates> {
  const [totals, apiKeyId, accountId, poolId, model, owner, tool] = await Promise.all([
    history.totals(window, filter),
    ...COLUMN_DIMENSIONS.map((dimension) => history.breakdown(window, dimension, limit, filter)),
    history.breakdown(window, "owner", limit, filter, attribution),
    history.breakdown(window, "tool", limit, filter, attribution),
  ])
  return {
    totals,
    breakdowns: {
      apiKeyId: apiKeyId ?? [],
      accountId: accountId ?? [],
      poolId: poolId ?? [],
      model: model ?? [],
      owner: owner ?? [],
      tool: tool ?? [],
    },
  }
}
