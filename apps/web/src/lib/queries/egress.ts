import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  fetchEgressOverview,
  setEgressProxy,
  setReplaceMode,
  testAccountProxy,
  testProxy,
} from "../api/egress"
import { invalidateAccountReaders } from "./account-readers"
import { queryKeys } from "./query-keys"

/** Longer than the console default: one read asks each proxy vendor for its whole list. */
const OVERVIEW_STALE_MS = 60_000

/** Every proxy the router can name and every account behind one. */
export function useEgressOverview() {
  return useQuery(() => ({
    queryKey: queryKeys.egress.overview(),
    queryFn: () => fetchEgressOverview(),
    staleTime: OVERVIEW_STALE_MS,
    retry: false,
  }))
}

// The account row carries its proxy's address and the overview carries who uses which, so a change
// to either side refetches both, and the audit log with them.
async function invalidateEgressReaders(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    invalidateAccountReaders(client),
    client.invalidateQueries({ queryKey: queryKeys.egress.root() }),
  ])
}

export function useSetEgressProxy() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: setEgressProxy,
    // A pasted proxy URL carries its password; it must not outlive the form.
    gcTime: 0,
    onSuccess: () => invalidateEgressReaders(client),
  }))
}

export function useSetReplaceMode() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: setReplaceMode,
    onSuccess: () => invalidateEgressReaders(client),
  }))
}

export function useTestProxy() {
  return useMutation(() => ({
    mutationFn: testProxy,
    gcTime: 0,
  }))
}

export function useTestAccountProxy() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (accountId: string) => testAccountProxy(accountId),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.egress.root() }),
  }))
}
