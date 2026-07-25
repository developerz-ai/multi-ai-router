import { useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { fetchUsageSummary, type UsageWindow } from "../api/usage"
import { queryKeys } from "./query-keys"

/**
 * Usage for one window, aggregated from the `UsageRecord` rows the router writes off the request
 * path.
 *
 * Shared by the usage screen and by the per-row usage cells on the keys and accounts tables — one
 * key per window, so opening either table after the usage screen is a cache hit rather than a
 * second aggregate over the same rows.
 */
export function useUsageSummary(window: Accessor<UsageWindow>) {
  return useQuery(() => ({
    queryKey: queryKeys.usage.summary(window()),
    queryFn: () => fetchUsageSummary(window()),
  }))
}
