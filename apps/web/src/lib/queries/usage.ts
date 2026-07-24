import { useQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { fetchUsageSummary, type UsageWindow } from "../api/usage"
import { queryKeys } from "./query-keys"

/**
 * Usage for one window.
 *
 * The data behind this is **generated, not measured** — see the banner at the
 * top of `lib/api/usage.ts`. This hook is written exactly as it will be once the
 * read API lands, so the swap stays a one-file change: same key, same shape,
 * same call site.
 */
export function useUsageSummary(window: Accessor<UsageWindow>) {
  return useQuery(() => ({
    queryKey: queryKeys.usage.summary(window()),
    queryFn: () => fetchUsageSummary(window()),
  }))
}
