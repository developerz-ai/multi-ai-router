import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { listEgressProxies, setEgressProxy } from "../api/egress"
import { invalidateAccountReaders } from "./account-readers"

export function useEgressProxies() {
  return useQuery(() => ({
    queryKey: ["egress-proxies"] as const,
    queryFn: () => listEgressProxies(),
    retry: false,
  }))
}

export function useSetEgressProxy() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: setEgressProxy,
    // The variables may carry a proxy password; see `router-keys.ts`.
    gcTime: 0,
    onSuccess: () => invalidateAccountReaders(client),
  }))
}
