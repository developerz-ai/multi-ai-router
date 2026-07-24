import { useQuery } from "@tanstack/solid-query"
import { listProviders } from "../api/providers"
import { queryKeys } from "./query-keys"

/**
 * The provider registry. It is defined in code, not in a table, so it cannot
 * change while the console is open — `staleTime: Infinity` means the "add
 * account" form is built from one request per page load rather than one per
 * open.
 */
export function useProviders() {
  return useQuery(() => ({
    queryKey: queryKeys.providers.list(),
    queryFn: () => listProviders(),
    staleTime: Number.POSITIVE_INFINITY,
  }))
}
