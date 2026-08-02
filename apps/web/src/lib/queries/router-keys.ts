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
//
// Every one of these — reveal included — is an audited action, so each also
// invalidates the audit root: the log must show a write (or a view) without a
// reload of the settings screen.

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
    onSuccess: () => invalidateKeyReaders(client),
  }))
}

export function useUpdateKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: { readonly id: string; readonly patch: UpdateKeyInput }) => updateKey(args),
    onSuccess: () => invalidateKeyReaders(client),
  }))
}

/**
 * The other one that carries a value. Same `gcTime` rule — and it still touches
 * the audit root, because a reveal changes no key but does append a `key.viewed`
 * row the log must show.
 */
export function useRevealKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => revealKey(id),
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.audit.root() }),
  }))
}

export function useRevokeKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => revokeKey(id),
    onSuccess: () => invalidateKeyReaders(client),
  }))
}

export function useDeleteKey() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => deleteKey(id),
    onSuccess: () => invalidateKeyReaders(client),
  }))
}

async function invalidateKeyReaders(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.keys.root() }),
    client.invalidateQueries({ queryKey: queryKeys.audit.root() }),
  ])
}
