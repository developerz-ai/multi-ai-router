import { QueryClient } from "@tanstack/solid-query"

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
