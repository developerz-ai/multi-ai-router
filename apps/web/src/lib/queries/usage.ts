import { useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { fetchUsageSummary, type UsageRange } from "../api/usage"
import { NO_USAGE_FILTERS, type UsageFilters } from "../api/usage-params"
import { fetchUsageReports } from "../api/usage-reports"
import { queryKeys } from "./query-keys"

/**
 * Usage for one window or custom range, aggregated from the `UsageRecord` rows the router writes
 * off the request path, optionally narrowed by owner, tool and model.
 *
 * Shared by the usage screen and by the per-row usage cells on the keys and accounts tables — an
 * unfiltered read keeps one key per window (`queryKeys.usage.summary`), so opening either table
 * after the usage screen is a cache hit rather than a second aggregate over the same rows. Those
 * tables never pass filters; the Usage page passes the ones in its URL.
 */
export function useUsageSummary(range: Accessor<UsageRange>, filters?: Accessor<UsageFilters>) {
  return useQuery(() => {
    const active = filters?.() ?? NO_USAGE_FILTERS
    return {
      queryKey: queryKeys.usage.summary(range(), active),
      queryFn: () => fetchUsageSummary(range(), active),
    }
  })
}

/** The stored weekly reports, newest week first. Read-only: delivery belongs to the task. */
export function useUsageReports() {
  return useQuery(() => ({
    queryKey: queryKeys.usage.reports(),
    queryFn: fetchUsageReports,
  }))
}
