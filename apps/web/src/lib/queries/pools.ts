import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  type CreatePoolInput,
  createPool,
  deletePool,
  listPools,
  type UpdatePoolInput,
  updatePool,
} from "../api/pools"
import { queryKeys } from "./query-keys"

// Server state for pools.
//
// Deleting a pool cascades its `api_key_pools` rows, so the keys list is stale
// afterwards — a key scoped to it would otherwise still show a pool that no
// longer exists. The API refuses the delete while any key names the pool, which
// makes this invalidation the *second* line of defence rather than the only one.

export function usePools() {
  return useQuery(() => ({
    queryKey: queryKeys.pools.list(),
    queryFn: () => listPools(),
  }))
}

export function useCreatePool() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (input: CreatePoolInput) => createPool(input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pools.root() }),
  }))
}

export function useUpdatePool() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: { readonly id: string; readonly patch: UpdatePoolInput }) =>
      updatePool(args),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.pools.root() }),
  }))
}

export function useDeletePool() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => deletePool(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.pools.root() })
      await client.invalidateQueries({ queryKey: queryKeys.keys.root() })
    },
  }))
}
