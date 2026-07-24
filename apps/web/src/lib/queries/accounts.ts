import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import {
  type AccountListFilter,
  type CreateAccountInput,
  createAccount,
  deleteAccount,
  disableAccount,
  listAccounts,
  type RecheckResult,
  recheckAccount,
  recheckAllAccounts,
  type UpdateAccountInput,
  updateAccount,
} from "../api/accounts"
import type { AccountView } from "../api/types"
import { queryKeys } from "./query-keys"

// Server state for accounts.
//
// Invalidation is wider than "the list this mutation changed" in two places,
// and both are deliberate:
//
// - A pool member row carries the account's **label, provider and status**
//   (`PoolMemberView`), so any account write makes every pool view stale.
// - Deleting an account cascades its `api_key_accounts` rows, so the keys list
//   is stale too. The API refuses the delete while a key names it, but the
//   operator's next move after re-scoping is the delete — and the keys table
//   must not still be showing the old scope when it lands.

export function useAccounts(filter: Accessor<AccountListFilter>) {
  return useQuery(() => ({
    queryKey: queryKeys.accounts.list(filter()),
    queryFn: () => listAccounts(filter()),
  }))
}

/** Everything, unfiltered — what the overview and the pool editor need. */
export function useAllAccounts() {
  return useQuery(() => ({
    queryKey: queryKeys.accounts.list({}),
    queryFn: () => listAccounts({}),
  }))
}

export function useCreateAccount() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (input: CreateAccountInput) => createAccount(input),
    onSuccess: () => invalidateAccountReaders(client),
  }))
}

export function useUpdateAccount() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (args: { readonly id: string; readonly patch: UpdateAccountInput }) =>
      updateAccount(args),
    onSuccess: () => invalidateAccountReaders(client),
  }))
}

export function useDisableAccount() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => disableAccount(id),
    onSuccess: () => invalidateAccountReaders(client),
  }))
}

export function useDeleteAccount() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => deleteAccount(id),
    onSuccess: async () => {
      await invalidateAccountReaders(client)
      await client.invalidateQueries({ queryKey: queryKeys.keys.root() })
    },
  }))
}

/**
 * A re-check clears the breaker marks and makes the account eligible again as a
 * half-open probe. It runs no synthetic request and therefore reports no
 * verdict — the status the accounts list shows is refreshed here because the
 * *marks* changed, not because the account was proven healthy.
 *
 * The result is written into the cache under its own key so the row can show
 * `lastCheckedAt` afterwards. See `useLastRecheck` for why that is needed.
 */
export function useRecheckAccount() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => recheckAccount(id),
    onSuccess: async (result: RecheckResult) => {
      client.setQueryData(queryKeys.accounts.recheck(result.accountId), result)
      await invalidateAccountReaders(client)
    },
  }))
}

export function useRecheckAllAccounts() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: () => recheckAllAccounts(),
    onSuccess: async (results: readonly RecheckResult[]) => {
      for (const result of results) {
        client.setQueryData(queryKeys.accounts.recheck(result.accountId), result)
      }
      await invalidateAccountReaders(client)
    },
  }))
}

/**
 * The last re-check this console knows about for one account.
 *
 * **Cache-only, and that is a gap, not a design.** `AccountView` carries no
 * `lastCheckedAt`, so on a cold load — a fresh tab, another operator's press —
 * there is nothing to show and the row says "not checked in this session"
 * rather than inventing a time. `enabled: false` keeps it a pure cache read:
 * there is no `GET` behind this key to call.
 */
export function useLastRecheck(id: Accessor<string>) {
  return useQuery(() => ({
    queryKey: queryKeys.accounts.recheck(id()),
    queryFn: (): RecheckResult | null => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }))
}

export type { AccountView }

async function invalidateAccountReaders(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.accounts.root() }),
    client.invalidateQueries({ queryKey: queryKeys.pools.root() }),
  ])
}
