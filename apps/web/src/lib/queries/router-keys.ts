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
// **The two calls that return a live credential do not leave it lying around.**
// Reveal and mint are audited server-side and answer with the value in the
// clear. Nothing writes that into the query cache, but being a mutation is not
// the same as being cache-free: TanStack parks a mutation's result in the
// client's *mutation* cache, and the default `gcTime` keeps it there for five
// minutes after the last observer detaches — long after the dialog showing it
// closed, readable by anything that can reach the client.
//
// So both carry `gcTime: 0`, which drops the entry as soon as nothing is
// observing it. The other half of the rule lives in `KeysRoute`, which resets
// whichever mutation produced the value when its dialog closes: a mounted
// screen never stops observing on its own, so without the reset the timer would
// never start. Neither half works alone.
//
// Keys stay retrievable through all of this — pressing reveal again is one more
// audited call, which is exactly the intended cost.

export function useKeys() {
  return useQuery(() => ({
    queryKey: queryKeys.keys.list(),
    queryFn: () => listKeys(),
  }))
}

/** Carries the minted value — see the note above on `gcTime`. */
export function useCreateKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (input: CreateKeyInput) => createKey(input),
    gcTime: 0,
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

/** The other one that carries a value. Same rule. */
export function useRevealKey() {
  return useMutation(() => ({
    mutationFn: (id: string) => revealKey(id),
    gcTime: 0,
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
