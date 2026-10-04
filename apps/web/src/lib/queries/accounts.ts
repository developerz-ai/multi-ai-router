import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import {
  type AccountListFilter,
  type CreateAccountInput,
  createAccount,
  type DiscoverModelsResult,
  deleteAccount,
  disableAccount,
  discoverAccountModels,
  listAccounts,
  type RecheckResult,
  recheckAccount,
  recheckAllAccounts,
  type TestAccountInput,
  type TestNowResult,
  testAccount,
  type UpdateAccountInput,
  updateAccount,
} from "../api/accounts"
import type { AccountView } from "../api/types"
import { LIVE_POLL_MS } from "../query"
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
    refetchInterval: LIVE_POLL_MS,
  }))
}

/** Everything, unfiltered — what the overview and the pool editor need. */
export function useAllAccounts() {
  return useQuery(() => ({
    queryKey: queryKeys.accounts.list({}),
    queryFn: () => listAccounts({}),
    refetchInterval: LIVE_POLL_MS,
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
    onSuccess: (result: RecheckResult) => {
      client.setQueryData(queryKeys.accounts.recheck(result.accountId), result)
    },
    // Settled, not success: the press may have cleared marks before the response failed.
    onSettled: () => invalidateAccountReaders(client),
  }))
}

export function useRecheckAllAccounts() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: () => recheckAllAccounts(),
    onSuccess: (results: readonly RecheckResult[]) => {
      for (const result of results) {
        client.setQueryData(queryKeys.accounts.recheck(result.accountId), result)
      }
    },
    onSettled: () => invalidateAccountReaders(client),
  }))
}

/**
 * "Test now": one real, opt-in completion against one account. The result is cached under its own
 * key, same pattern as `useRecheckAccount` — a row shows the last press regardless of which
 * mutation wrote it last.
 */
export function useTestAccount() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (input: TestAccountInput) => testAccount(input),
    onSuccess: (result: TestNowResult) => {
      client.setQueryData(queryKeys.accounts.test(result.accountId), result)
    },
    // A test is one real completion: it writes a usage row and can flip the status (an auth
    // failure lands as `needs_reauth`) whether or not the call itself came back ok.
    onSettled: async () => {
      await invalidateAccountReaders(client)
      await client.invalidateQueries({ queryKey: queryKeys.usage.root() })
    },
  }))
}

/**
 * "Discover models": one GET at the provider's own listing, written into the account. It changes
 * the row, so the account readers are invalidated — the model set the table shows has to be the one
 * that was just written, not the one the row held a moment ago.
 */
export function useDiscoverAccountModels() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (id: string) => discoverAccountModels(id),
    onSuccess: (result: DiscoverModelsResult) => {
      client.setQueryData(queryKeys.accounts.models(result.accountId), result)
    },
    onSettled: () => invalidateAccountReaders(client),
  }))
}

/**
 * The last "Test now" this console knows about for one account. Cache-only: `AccountView` carries
 * no last-test field (a test's verdict is a moment's observation, not account state), so a cold
 * load says nothing was tested in this session rather than inventing a result. `enabled: false`
 * keeps it a pure cache read — there is no `GET` behind this key to call.
 */
export function useLastTest(id: Accessor<string>) {
  return useQuery(() => ({
    queryKey: queryKeys.accounts.test(id()),
    queryFn: (): TestNowResult | null => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }))
}

/**
 * The last re-check *press* this console made for one account.
 *
 * Cache-only, and no longer the row's only source of a timestamp: the accounts read carries
 * `availability.lastCheckedAt` — what the **server** remembers — and `AccountRecheck` prefers a
 * press result only because that one also carries `nextAllowedAt` (the cooldown verdict, which
 * the read cannot know). What the server remembers is still per-process memory beside the breaker
 * marks it guards (`services/accounts/recheck.ts`), so after a router restart both sources are
 * empty and the row honestly says "Not checked since restart" rather than inventing a time.
 * `enabled: false` keeps this a pure cache read: there is no `GET` behind this key to call.
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
    // Every mutation routed through here is an audited action; without this the
    // audit table only updates on a reload, which reads as a write not recorded.
    client.invalidateQueries({ queryKey: queryKeys.audit.root() }),
  ])
}
