import { type DefaultOptions, QueryClient } from "@tanstack/solid-query"
import { ApiError } from "./api/errors"

/**
 * How often the fleet reads — accounts and pools — re-fetch on their own while a tab is visible.
 *
 * Account status, quota windows and breaker state move without any operator action (a window
 * refills, a probe flips a subscription to `needs_reauth`), so a console left open must show that
 * happening without a reload. Twenty seconds is far below the cadence of anything that changes
 * them and the reads are cached in-process on the router. TanStack's default
 * `refetchIntervalInBackground: false` pauses the poll while the tab is hidden, so an idle
 * second-monitor tab costs nothing. The two faster polls (task health, the live request feed)
 * keep their own numbers beside their queries; every other read refetches only on focus,
 * reconnect, or invalidation by a mutation.
 */
export const LIVE_POLL_MS = 20_000

/**
 * One retry, for genuine transport blips and `5xx` — never for a `4xx`. A `401` is a session
 * event (retrying only delays the redirect to /login, and every poll would repeat it), and a
 * `400`/`403`/`404` answers the same the second time, so repeating it only shows the error card
 * a second late.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false
  return failureCount < 1
}

// Server state for the admin plane, configured in exactly one place. Defaults
// suit an operator console left open on a second monitor: refetch when the tab
// regains focus (the numbers moved while you were away), without hammering the
// admin API on every mouse-over.
export const QUERY_DEFAULTS = {
  staleTime: 15_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: shouldRetryQuery,
  // solid-query switches TanStack's structural sharing off, so without this every refetch hands
  // the screen brand-new objects even for a byte-identical body, and every row, group and input
  // under it is disposed and rebuilt. Reconciling by `id` keeps each row's object (and so its
  // DOM) and writes only the fields that changed. Rows without an `id` are matched by position.
  reconcile: "id",
} satisfies NonNullable<DefaultOptions["queries"]>

export const queryClient = new QueryClient({ defaultOptions: { queries: QUERY_DEFAULTS } })
