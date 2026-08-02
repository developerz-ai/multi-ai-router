import { useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  beginConnect,
  type ConnectCancelled,
  type ConnectCompleted,
  type ConnectMode,
  type ConnectStarted,
  cancelConnect,
  completeConnect,
} from "../api/connect"
import { queryKeys } from "./query-keys"

// Connect is three mutations and no query.
//
// The started login is **not** cached: it is one-shot, it expires on a short TTL, and a second
// tab reading it from a cache would be reading a `state` that the first tab is about to burn. It
// lives in the dialog's own signal for exactly as long as that dialog is open, and `cancel` is
// what disposes of it early — abandoning the pending row and any subprocess with it rather than
// leaving both to their TTL.
//
// Completing a login changes `hasCredential`, `status` and `tokenExpiresAt` on the account, and
// pool member rows carry the status — so the same readers a normal account write invalidates are
// invalidated here.

export function useBeginConnect() {
  return useMutation(() => ({
    mutationFn: (args: {
      readonly id: string
      readonly mode: ConnectMode
    }): Promise<ConnectStarted> => beginConnect(args),
  }))
}

export function useCompleteConnect() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: {
      readonly id: string
      readonly pasted: string
    }): Promise<ConnectCompleted> => completeConnect(args),
    onSuccess: () => invalidateAccountReaders(client),
  }))
}

/**
 * Cancelling still invalidates. A login that was abandoned mid-flight may have left the account
 * in `needs_reauth`, and a row that keeps claiming otherwise is the wrong answer to "did that
 * work".
 */
export function useCancelConnect() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string): Promise<ConnectCancelled> => cancelConnect(id),
    onSuccess: () => invalidateAccountReaders(client),
  }))
}

async function invalidateAccountReaders(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.accounts.root() }),
    client.invalidateQueries({ queryKey: queryKeys.pools.root() }),
    // Completing or abandoning a login is audited; the log must not wait for a reload.
    client.invalidateQueries({ queryKey: queryKeys.audit.root() }),
  ])
}
