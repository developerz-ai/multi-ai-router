import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../components/Button"
import { EmptyState } from "../components/EmptyState"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { TableSkeleton } from "../components/TableSkeleton"
import { groupAccountsByProvider, poolNamesFor } from "../lib/account-groups"
import type { AccountListFilter } from "../lib/api/accounts"
import { findProvider } from "../lib/api/providers"
import type { AccountView, ProviderConnectFlow } from "../lib/api/types"
import { createNow } from "../lib/clock"
import {
  useAccounts,
  useCreateAccount,
  useDeleteAccount,
  useDisableAccount,
  useDiscoverAccountModels,
  useRecheckAccount,
  useRecheckAllAccounts,
  useTestAccount,
  useUpdateAccount,
} from "../lib/queries/accounts"
import { usePools } from "../lib/queries/pools"
import { useProviders } from "../lib/queries/providers"
import { useTableUsage } from "../lib/queries/table-usage"
import styles from "./AccountsRoute.module.scss"
import { AccountConnect } from "./accounts/AccountConnect"
import { AccountDeleteDialog } from "./accounts/AccountDeleteDialog"
import { AccountEditDialog } from "./accounts/AccountEditDialog"
import { AccountFormDialog } from "./accounts/AccountFormDialog"
import { AccountsFilters } from "./accounts/AccountsFilters"
import { AccountsNotices } from "./accounts/AccountsNotices"
import { AccountsTable } from "./accounts/AccountsTable"
import { ProviderGroup } from "./accounts/ProviderGroup"
import { ReconnectSequence } from "./accounts/ReconnectSequence"
import { SubscriptionBanner } from "./accounts/SubscriptionBanner"

/**
 * The fleet, grouped by provider.
 *
 * Pooling is the product, so nothing here assumes one account per provider — six Claude
 * subscriptions side by side is the normal case, which is exactly why they read as one section
 * with one header (how many, how many routable, when the next login dies) over a dense table,
 * rather than as six rows lost among eleven. Groups with a problem come first; the filters still
 * narrow the whole page.
 */
export default function AccountsRoute() {
  const now = createNow()
  // Grouping classifies logins in days, so it reads a coarse clock: rebuilding every group on the
  // one-second tick would re-mount seven tables a second and dismiss any tooltip mid-read.
  const groupingNow = createNow(60_000)
  const [status, setStatus] = createSignal<AccountStatus | "">("")
  const [provider, setProvider] = createSignal<ProviderId | "">("")
  const [adding, setAdding] = createSignal(false)
  const [editing, setEditing] = createSignal<AccountView | null>(null)
  const [pendingDelete, setPendingDelete] = createSignal<AccountView | null>(null)
  const [connecting, setConnecting] = createSignal<AccountView | null>(null)
  /** The accounts a "Reconnect all" run walks, or null while none is running. */
  const [reconnectQueue, setReconnectQueue] = createSignal<readonly AccountView[] | null>(null)

  const filter = createMemo<AccountListFilter>(() => ({
    ...(status() === "" ? {} : { status: status() as AccountStatus }),
    ...(provider() === "" ? {} : { provider: provider() as ProviderId }),
  }))

  const accounts = useAccounts(filter)
  const pools = usePools()
  const poolList = () => (pools.isSuccess ? (pools.data ?? []) : [])
  const providers = useProviders()
  const providerList = () => (providers.isSuccess ? (providers.data ?? []) : [])
  const accountList = () => (accounts.isSuccess ? (accounts.data ?? []) : [])

  const groups = createMemo(() => groupAccountsByProvider(accountList(), groupingNow()))
  // `For` keys by identity and provider ids are strings, so the sections keep their DOM — and
  // their collapsed state — across every refetch; the group objects underneath are looked up.
  const groupOrder = createMemo(() => groups().map((group) => group.provider))
  const groupFor = (provider: string) => groups().find((group) => group.provider === provider)

  // Asked of the descriptor, never of a list kept here: a provider that grows a login becomes
  // connectable the day its driver file lands (CLAUDE.md non-negotiable 12).
  const providerFor = (account: AccountView) => findProvider(providerList(), account.provider)

  const connectFlowFor = (account: AccountView): ProviderConnectFlow | null =>
    providerFor(account)?.connectFlow ?? null

  const connectingFlow = createMemo(() => {
    const account = connecting()
    return account === null ? null : connectFlowFor(account)
  })

  const reconnectFlow = createMemo(() => {
    const first = reconnectQueue()?.[0]
    return first === undefined ? null : connectFlowFor(first)
  })

  const editingProvider = createMemo(() => {
    const account = editing()
    return account === null ? undefined : providerFor(account)
  })

  const usage = useTableUsage("account")

  const create = useCreateAccount()
  const update = useUpdateAccount()
  const disable = useDisableAccount()
  const remove = useDeleteAccount()
  const recheck = useRecheckAccount()
  const recheckAll = useRecheckAllAccounts()
  const test = useTestAccount()
  const discover = useDiscoverAccountModels()

  const closeForm = () => {
    create.reset()
    setAdding(false)
  }

  const openEdit = (account: AccountView) => {
    update.reset()
    setEditing(account)
  }

  const closeEdit = () => {
    update.reset()
    setEditing(null)
  }

  const closeDelete = () => {
    remove.reset()
    setPendingDelete(null)
  }

  const startReconnectAll = (queue: readonly AccountView[]) => {
    if (queue.length === 0) return
    setConnecting(null)
    setReconnectQueue(queue)
  }

  return (
    <>
      <PageHeader
        actions={
          <>
            {/* The same probe path the half-open transition uses — one code
                path, a server-side cooldown, never a second mechanism. */}
            <Button busy={recheckAll.isPending} onClick={() => recheckAll.mutate()} tone="neutral">
              Re-check all
            </Button>
            <Button onClick={() => setAdding(true)} tone="primary">
              Add account
            </Button>
          </>
        }
        subtitle="Upstream subscriptions and API keys, grouped by provider. Many accounts of the same provider is the normal case."
        title="Accounts"
      />

      <SubscriptionBanner
        accounts={accountList()}
        action={(health) => (
          <Show when={health.needsReconnect.length > 0}>
            <Button onClick={() => startReconnectAll(health.needsReconnect)} tone="primary">
              Reconnect all ({health.needsReconnect.length})
            </Button>
          </Show>
        )}
        nowMs={now()}
      />

      <AccountsNotices discover={discover} recheckAll={recheckAll} />

      <AccountsFilters
        onProvider={setProvider}
        onStatus={setStatus}
        provider={provider()}
        providers={providerList()}
        status={status()}
      />

      <QueryBoundary
        errorTitle="Accounts could not be loaded"
        loading={<TableSkeleton label="Loading accounts" rows={5} />}
        query={accounts}
      >
        {(rows) => (
          <Show
            fallback={
              <EmptyState
                action={
                  <Button onClick={() => setAdding(true)} tone="primary">
                    Add account
                  </Button>
                }
                description="An account is one upstream subscription or API key. Attach several of the same provider — the router pools them behind one endpoint and picks between them per request."
                icon="accounts"
                title={
                  status() === "" && provider() === ""
                    ? "No accounts yet"
                    : "No accounts match this filter"
                }
              />
            }
            when={rows.length > 0}
          >
            <div class={styles.groups}>
              <For each={groupOrder()}>
                {(provider) => (
                  <Show when={groupFor(provider)}>
                    {(group) => (
                      <ProviderGroup
                        group={group()}
                        nowMs={now()}
                        pools={poolNamesFor(poolList(), group().accounts)}
                        onReconnectAll={startReconnectAll}
                      >
                        <AccountsTable
                          accounts={group().accounts}
                          caption={`${group().name} — reset shown as absolute time and countdown, labelled by how much the instant can be trusted.`}
                          nowMs={now()}
                          onConnect={setConnecting}
                          onDelete={setPendingDelete}
                          onDisable={(account) => disable.mutate(account.id)}
                          onDiscoverModels={(id) => discover.mutate(id)}
                          onEdit={openEdit}
                          onEnable={(account) =>
                            update.mutate({ id: account.id, patch: { status: "active" } })
                          }
                          onRecheck={(id) => recheck.mutate(id)}
                          onTest={(input) => test.mutate(input)}
                          discoveringId={discover.isPending ? (discover.variables ?? null) : null}
                          providerFor={providerFor}
                          recheckingId={recheck.isPending ? (recheck.variables ?? null) : null}
                          testingId={test.isPending ? (test.variables?.id ?? null) : null}
                          {...usage()}
                        />
                      </ProviderGroup>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        )}
      </QueryBoundary>

      <AccountFormDialog
        busy={create.isPending}
        error={create.error}
        onClose={closeForm}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (account) => {
              closeForm()
              // A provider that takes a login lands here unauthorised on purpose — the row exists
              // so the one-shot `state` has something to bind to. Going straight into Connect is
              // the rest of the same gesture, not a second task the operator has to remember.
              if (connectFlowFor(account) !== null) setConnecting(account)
            },
          })
        }
        open={adding()}
        providers={providerList()}
      />

      <AccountEditDialog
        account={editing()}
        busy={update.isPending}
        error={update.error}
        onClose={closeEdit}
        onSubmit={(patch) => {
          const target = editing()
          if (target === null) return
          update.mutate({ id: target.id, patch }, { onSuccess: closeEdit })
        }}
        open={editing() !== null}
        provider={editingProvider()}
      />

      <AccountConnect
        account={connecting()}
        connectFlow={connectingFlow()}
        nowMs={now()}
        onClose={() => setConnecting(null)}
      />

      <ReconnectSequence
        accounts={accountList()}
        connectFlow={reconnectFlow()}
        nowMs={now()}
        onClose={() => setReconnectQueue(null)}
        open={reconnectQueue() !== null}
        queue={reconnectQueue() ?? []}
      />

      <AccountDeleteDialog
        account={pendingDelete()}
        busy={remove.isPending}
        error={remove.error}
        onClose={closeDelete}
        onConfirm={(account) => remove.mutate(account.id, { onSuccess: closeDelete })}
      />
    </>
  )
}
