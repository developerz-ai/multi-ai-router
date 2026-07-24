import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  type CreateKeyInput,
  createKey,
  deleteKey,
  listKeys,
  revealKey,
  revokeKey,
  type UpdateKeyInput,
  updateKey,
} from "../api/router-keys"
import { queryKeys } from "./query-keys"

// Server state for router keys.
//
// **Reveal is a mutation with no cache write.** It is audited server-side and
// returns a live credential; caching that value would leave it sitting in the
// query cache for the rest of the tab's life, readable by anything that can
// reach the client. The value goes straight to the component that asked for it
// and is dropped when that dialog closes. Keys stay retrievable — pressing
// reveal again is one more audited call, which is exactly the intended cost.

export function useKeys() {
  return useQuery(() => ({
    queryKey: queryKeys.keys.list(),
    queryFn: () => listKeys(),
  }))
}

export function useCreateKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (input: CreateKeyInput) => createKey(input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys.root() }),
  }))
}

export function useUpdateKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: { readonly id: string; readonly patch: UpdateKeyInput }) => updateKey(args),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys.root() }),
  }))
}

export function useRevealKey() {
  return useMutation(() => ({
    mutationFn: (id: string) => revealKey(id),
  }))
}

export function useRevokeKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => revokeKey(id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys.root() }),
  }))
}

export function useDeleteKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => deleteKey(id),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys.root() }),
  }))
}
