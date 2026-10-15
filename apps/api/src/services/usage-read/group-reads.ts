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
