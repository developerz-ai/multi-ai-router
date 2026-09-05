import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  type CreatePoolInput,
  createPool,
  deletePool,
  listPools,
  type UpdatePoolInput,
  updatePool,
} from "../api/pools"
import { LIVE_POLL_MS } from "../query"
import { queryKeys } from "./query-keys"

// Server state for pools.
//
// Deleting a pool cascades its `api_key_pools` rows, so the keys list is stale
// afterwards — a key scoped to it would otherwise still show a pool that no
// longer exists. The API refuses the delete while any key names the pool, which
// makes this invalidation the *second* line of defence rather than the only one.
//
// Every pool write is an audited action, so each mutation also invalidates the
// audit root — the log on the settings screen must show a write without a reload.

export function usePools() {
  return useQuery(() => ({
    queryKey: queryKeys.pools.list(),
    queryFn: () => listPools(),
    // Member rows carry account status, which moves on its own — see `LIVE_POLL_MS`.
    refetchInterval: LIVE_POLL_MS,
  }))
}

export function useCreatePool() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (input: CreatePoolInput) => createPool(input),
    onSuccess: () => invalidatePoolReaders(client),
  }))
}

export function useUpdatePool() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: { readonly id: string; readonly patch: UpdatePoolInput }) =>
      updatePool(args),
    onSuccess: () => invalidatePoolReaders(client),
  }))
}

export function useDeletePool() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => deletePool(id),
    onSuccess: async () => {
      await invalidatePoolReaders(client)
      await client.invalidateQueries({ queryKey: queryKeys.keys.root() })
    },
  }))
}

async function invalidatePoolReaders(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.pools.root() }),
    client.invalidateQueries({ queryKey: queryKeys.audit.root() }),
  ])
}
