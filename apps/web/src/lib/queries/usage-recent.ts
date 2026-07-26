import { keepPreviousData, useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { fetchRecentAttempts, type RecentQuery } from "../api/usage-recent"
import { queryKeys } from "./query-keys"

/**
 * The live request feed — individual attempts, newest first.
 *
 * Polled, and one of only two reads in the console that are. "Live" is the whole
 * proposition: an operator watching this while a colleague retries a failing
 * tool must see the attempt arrive without reloading, or the surface is a log
 * tail that needs a refresh button. Ten seconds is fast enough to feel live and
 * far slower than the admin plane's cost — one indexed `ORDER BY … LIMIT n` that
 * touches nothing on the request path.
 *
 * `refetchOnWindowFocus` rides the default rather than being switched off: a tab
 * an operator comes back to should not be showing the traffic from when they
 * left it.
 */
export const RECENT_POLL_MS = 10_000

export function useRecentAttempts(query: Accessor<RecentQuery>) {
  return useQuery(() => ({
    queryKey: queryKeys.usage.recent(query()),
    queryFn: () => fetchRecentAttempts(query()),
    refetchInterval: RECENT_POLL_MS,
    // The feed is one moving window under several filters. Holding the previous page while the
    // next one lands stops a filter switch blanking the table to a skeleton every time.
    placeholderData: keepPreviousData,
  }))
}
