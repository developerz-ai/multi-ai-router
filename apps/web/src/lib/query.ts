import { QueryClient } from "@tanstack/solid-query"

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

// Server state for the admin plane, configured in exactly one place. Defaults
// suit an operator console left open on a second monitor: refetch when the tab
// regains focus (the numbers moved while you were away), without hammering the
// admin API on every mouse-over.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // An expired admin session returns 401; retrying it only delays the
      // redirect to /login. Retry once, for genuine transport blips.
      retry: 1,
    },
  },
})
