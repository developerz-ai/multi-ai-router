import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { fetchUsageSummary, type UsageRange } from "../api/usage"
import { NO_USAGE_FILTERS, type UsageFilters } from "../api/usage-params"
import { deliverUsageReport, fetchUsageReports } from "../api/usage-reports"
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
/**
 * How long a summary counts as fresh. Longer than the console default on purpose: one summary is
 * a couple of dozen aggregates over the raw usage rows server-side, and the accounts and keys
 * tables read the 7-day one too — so under the default every tab refocus on any of three screens
 * re-ran all of them. A minute-old aggregate is not a stale one; a mutation that changes usage
 * still invalidates it at once.
 */
export const USAGE_SUMMARY_STALE_MS = 60_000

export function useUsageSummary(range: Accessor<UsageRange>, filters?: Accessor<UsageFilters>) {
  return useQuery(() => {
    const active = filters?.() ?? NO_USAGE_FILTERS
    return {
      queryKey: queryKeys.usage.summary(range(), active),
      queryFn: () => fetchUsageSummary(range(), active),
      staleTime: USAGE_SUMMARY_STALE_MS,
    }
  })
}

/** The stored weekly reports, newest week first. */
export function useUsageReports() {
  return useQuery(() => ({
    queryKey: queryKeys.usage.reports(),
    queryFn: fetchUsageReports,
    // A stored report is identified by its week, not an `id`.
    reconcile: "periodStart",
  }))
}

/**
 * The re-send (issue #229). Settled — not just succeeded — invalidates the list: a failed re-send
 * moves the row too (status, attempts, last error), and the Delivery column would otherwise show
 * the state from before the click.
 */
export function useDeliverUsageReport() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (periodStart: string) => deliverUsageReport(periodStart),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.usage.reports() }),
  }))
}
