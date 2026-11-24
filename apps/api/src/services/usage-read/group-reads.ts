import type {
  UsageDimension,
  UsageFilter,
  UsageHistoryRepository,
  UsageKeyAttribution,
  UsageReadRepository,
  UsageWindow,
} from "@multi-ai-router/db"

/**
 * One grouped read per repository method, dispatching on the dimension so the owner and tool
 * overloads (which require the key attribution) and the column overloads (which take none) are
 * each satisfied by construction. The attribution is built once per request by the caller.
 */
export function historyBreakdown(
  history: UsageHistoryRepository,
  window: UsageWindow,
  dimension: UsageDimension,
  limit: number,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
) {
  return dimension === "owner" || dimension === "tool"
    ? history.breakdown(window, dimension, limit, filter, attribution)
    : history.breakdown(window, dimension, limit, filter)
}

export function rawBreakdown(
  raw: UsageReadRepository,
  window: UsageWindow,
  dimension: UsageDimension,
  ids: readonly (string | null)[],
  limit: number,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
) {
  return dimension === "owner" || dimension === "tool"
    ? raw.breakdown(window, dimension, ids, limit, filter, attribution)
    : raw.breakdown(window, dimension, ids, limit, filter)
}

export function historySeriesBy(
  history: UsageHistoryRepository,
  window: UsageWindow,
  bucket: "hour" | "day",
  dimension: UsageDimension,
  width: number,
  ids: readonly (string | null)[],
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
) {
  return dimension === "owner" || dimension === "tool"
    ? history.seriesByDimension(window, bucket, dimension, width, ids, filter, attribution)
    : history.seriesByDimension(window, bucket, dimension, width, ids, filter)
}

type GroupLatencies = Awaited<ReturnType<NonNullable<UsageReadRepository["groupLatency"]>>>

/**
 * Per-group latency for the rows each breakdown selected, one list per dimension in request order.
 * One `GROUPING SETS` statement where the repository has it; six id-narrowed `breakdown` reads
 * otherwise (a hand-built repository). Both answer the same numbers for the same group.
 */
export async function groupLatencies(
  raw: UsageReadRepository,
  window: UsageWindow,
  dimensions: readonly UsageDimension[],
  selected: readonly (readonly (string | null)[])[],
  limit: number,
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
): Promise<readonly GroupLatencies[UsageDimension][]> {
  if (raw.groupLatency !== undefined) {
    const all = await raw.groupLatency(window, filter, attribution, idsBy(dimensions, selected))
    return dimensions.map((dimension) => all[dimension])
  }
  return Promise.all(
    dimensions.map((dimension, index) =>
      rawBreakdown(raw, window, dimension, selected[index] ?? [], limit, filter, attribution),
    ),
  )
}

/** The selected ids keyed by dimension; a dimension the caller did not ask for selects nothing. */
function idsBy(
  dimensions: readonly UsageDimension[],
  selected: readonly (readonly (string | null)[])[],
): Record<UsageDimension, readonly (string | null)[]> {
  const none: readonly (string | null)[] = []
  const ids = {
    apiKeyId: none,
    accountId: none,
    poolId: none,
    model: none,
    owner: none,
    tool: none,
  }
  dimensions.forEach((dimension, index) => {
    ids[dimension] = selected[index] ?? none
  })
  return ids
}

type GroupSeries = Awaited<ReturnType<NonNullable<UsageHistoryRepository["seriesByDimensions"]>>>

/**
 * The sparkline series for the rows each breakdown selected, one list per dimension in request
 * order. One `GROUPING SETS` statement where the repository has it; six `seriesByDimension` reads
 * otherwise (a hand-built repository). Both answer the same points for the same group.
 */
export async function groupSeriesBy(
  history: UsageHistoryRepository,
  window: UsageWindow,
  bucket: "hour" | "day",
  dimensions: readonly UsageDimension[],
  width: number,
  selected: readonly (readonly (string | null)[])[],
  filter: UsageFilter,
  attribution: UsageKeyAttribution,
): Promise<readonly GroupSeries[UsageDimension][]> {
  if (history.seriesByDimensions !== undefined) {
    const ids = idsBy(dimensions, selected)
    const all = await history.seriesByDimensions(window, bucket, width, ids, filter, attribution)
    return dimensions.map((dimension) => all[dimension])
  }
  return Promise.all(
    dimensions.map((dimension, index) =>
      historySeriesBy(
        history,
        window,
        bucket,
        dimension,
        width,
        selected[index] ?? [],
        filter,
        attribution,
      ),
    ),
  )
}
