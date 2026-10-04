import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { type Accessor, createEffect } from "solid-js"
import {
  beginConnect,
  beginDeviceConnect,
  type ConnectCancelled,
  type ConnectCompleted,
  type ConnectMode,
  type ConnectStarted,
  cancelConnect,
  completeConnect,
  type DeviceConnectStarted,
  type DeviceConnectStatus,
  getDeviceConnectStatus,
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
// Completing a login changes `hasCredential`, `status`, `credential` and `tokenExpiresAt` on the
// account, and pool member rows carry the status — so the same readers a normal account write
// invalidates are invalidated here.
//
// **On settle, not on success.** A completion that fails *after* the CLI wrote its credential
// file, or a start that flips the row into a pending state, has changed the account whether or
// not the response said so. Invalidating only the happy path is how an operator reconnects a
// subscription and still sees `needs_reauth` until a reload.

export function useBeginConnect() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: {
      readonly id: string
      readonly mode: ConnectMode
    }): Promise<ConnectStarted> => beginConnect(args),
    onSettled: () => invalidateAccountReaders(client),
  }))
}

export function useCompleteConnect() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: {
      readonly id: string
      readonly pasted: string
    }): Promise<ConnectCompleted> => completeConnect(args),
    onSettled: () => invalidateAccountReaders(client),
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
    onSettled: () => invalidateAccountReaders(client),
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

export function useBeginDeviceConnect() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: {
      readonly id: string
      readonly mode: ConnectMode
    }): Promise<DeviceConnectStarted> => beginDeviceConnect(args),
    onSettled: () => invalidateAccountReaders(client),
  }))
}

/**
 * A pending device sign-in, re-read at the issuer's own interval while it waits and never once it
 * has ended. Not cached across dialogs: the key carries the attempt's start time, so a new attempt
 * on the same account never reads the previous one's outcome.
 */
export function useDeviceConnectStatus(
  id: Accessor<string | null>,
  attempt: Accessor<DeviceConnectStarted | null>,
) {
  const client = useQueryClient()
  const query = useQuery(() => {
    const started = attempt()
    return {
      queryKey: queryKeys.accounts.connectDevice(id() ?? "", started?.expiresAt ?? ""),
      queryFn: (): Promise<DeviceConnectStatus> => getDeviceConnectStatus(id() ?? ""),
      enabled: id() !== null && started !== null,
      gcTime: 0,
      // The operator is on the issuer's page in another tab while this waits — exactly when a
      // background tab would otherwise stop asking (production, 2026-10-04: a 16 s gap).
      refetchIntervalInBackground: true,
      refetchInterval: (q: { state: { data: DeviceConnectStatus | undefined } }) =>
        q.state.data === undefined || q.state.data.status === "waiting"
          ? (started?.intervalSeconds ?? 5) * 1_000
          : false,
    }
  })
  // A landed login changed the account; the readers learn it without a reload.
  createEffect(() => {
    if (query.data?.status === "connected") void invalidateAccountReaders(client)
  })
  return query
}
