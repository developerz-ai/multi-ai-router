import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Banner } from "../components/Banner"
import { Button } from "../components/Button"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { EmptyState } from "../components/EmptyState"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { TableSkeleton } from "../components/TableSkeleton"
import { needsOperator, STATUS_DISPLAY_ORDER, statusLabel } from "../lib/account-status"
import type { AccountListFilter } from "../lib/api/accounts"
import { errorMessage } from "../lib/api/errors"
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
import { useProviders } from "../lib/queries/providers"
import { useTableUsage } from "../lib/queries/table-usage"
import styles from "./AccountsRoute.module.scss"
import { AccountConnect } from "./accounts/AccountConnect"
import { AccountEditDialog } from "./accounts/AccountEditDialog"
import { AccountFormDialog } from "./accounts/AccountFormDialog"
import { AccountsTable } from "./accounts/AccountsTable"

/**
 * The fleet, one row per upstream account.
 *
 * Pooling is the product, so nothing here assumes one account per provider —
 * the filter is by provider *and* status precisely because five Claude
 * subscriptions side by side is the normal case, not an edge one.
 */
export default function AccountsRoute() {
  const now = createNow()
  const [status, setStatus] = createSignal<AccountStatus | "">("")
  const [provider, setProvider] = createSignal<ProviderId | "">("")
  const [adding, setAdding] = createSignal(false)
  const [editing, setEditing] = createSignal<AccountView | null>(null)
  const [pendingDelete, setPendingDelete] = createSignal<AccountView | null>(null)
  const [connecting, setConnecting] = createSignal<AccountView | null>(null)

  const filter = createMemo<AccountListFilter>(() => ({
    ...(status() === "" ? {} : { status: status() as AccountStatus }),
    ...(provider() === "" ? {} : { provider: provider() as ProviderId }),
  }))

  const accounts = useAccounts(filter)
  const providers = useProviders()
  const providerList = () => (providers.isSuccess ? (providers.data ?? []) : [])

  // Asked of the descriptor, never of a list kept here: a provider that grows a login becomes
  // connectable the day its driver file lands (CLAUDE.md non-negotiable 12). The same lookup
  // answers whether it needs a credential at all, so the table reads one object rather than two
  // parallel callbacks.
  const providerFor = (account: AccountView) => findProvider(providerList(), account.provider)

  const connectFlowFor = (account: AccountView): ProviderConnectFlow | null =>
    providerFor(account)?.connectFlow ?? null

  const connectingFlow = createMemo(() => {
    const account = connecting()
    return account === null ? null : connectFlowFor(account)
  })

  // The edit form reads every one of its rules off the descriptor — which login this
  // provider takes, whether it needs an address, which dialects it serves.
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
        subtitle="Upstream subscriptions and API keys. Many accounts of the same provider is the normal case."
        title="Accounts"
      />

      <Show when={recheckAll.isError}>
        <Banner title="Re-check all failed" tone="danger">
          {errorMessage(recheckAll.error)}
        </Banner>
      </Show>

      {/* A failed discovery has to say so somewhere: the button's own cell has room for a state,
          not for a reason, and "could not read the model listing: …" is the whole diagnosis. */}
      <Show when={discover.isError}>
        <Banner title="Model discovery failed" tone="danger">
          {errorMessage(discover.error)}
        </Banner>
      </Show>

      <Show when={discover.isSuccess && discover.data?.saved === false}>
        <Banner title="The upstream listed no models" tone="warn">
          {discover.data?.message}
        </Banner>
      </Show>

      <form class={styles.filters}>
        <label class={styles.filter}>
          <span class={styles.filterLabel}>Status</span>
          <select
            class={styles.select}
            onChange={(event) => setStatus(event.currentTarget.value as AccountStatus | "")}
            value={status()}
          >
            <option value="">Any status</option>
            <For each={STATUS_DISPLAY_ORDER}>
              {(value) => <option value={value}>{statusLabel(value)}</option>}
            </For>
          </select>
        </label>

        <label class={styles.filter}>
          <span class={styles.filterLabel}>Provider</span>
          <select
            class={styles.select}
            onChange={(event) => setProvider(event.currentTarget.value as ProviderId | "")}
            value={provider()}
          >
            <option value="">Any provider</option>
            <For each={providerList()}>
              {(descriptor) => <option value={descriptor.id}>{descriptor.id}</option>}
            </For>
          </select>
        </label>
      </form>

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
            <AccountsTable
              accounts={rows}
              nowMs={now()}
              onConnect={setConnecting}
              onDelete={setPendingDelete}
              onDisable={(account) => disable.mutate(account.id)}
              onDiscoverModels={(id) => discover.mutate(id)}
              onEdit={openEdit}
              onEnable={(account) => update.mutate({ id: account.id, patch: { status: "active" } })}
              onRecheck={(id) => recheck.mutate(id)}
              onTest={(input) => test.mutate(input)}
              discoveringId={discover.isPending ? (discover.variables ?? null) : null}
              providerFor={providerFor}
              recheckingId={recheck.isPending ? (recheck.variables ?? null) : null}
              testingId={test.isPending ? (test.variables?.id ?? null) : null}
              {...usage()}
            />
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

      <Show when={pendingDelete()}>
        {(account) => (
          <ConfirmDialog
            busy={remove.isPending}
            confirmLabel="Delete account"
            consequences={deleteConsequences(account())}
            error={remove.error}
            onClose={closeDelete}
            onConfirm={() => remove.mutate(account().id, { onSuccess: closeDelete })}
            open
            subject={account().label}
            title="Delete this account?"
          />
        )}
      </Show>
    </>
  )
}

/**
 * Exactly what breaks, in the operator's terms — never "this cannot be undone".
 * The server adds the decisive one when it refuses: a 409 naming every key whose
 * scope this delete would narrow, which `ConfirmDialog` renders verbatim.
 */
function deleteConsequences(account: AccountView): readonly string[] {
  return [
    `"${account.label}" is removed from every pool it belongs to.`,
    "Its usage history is kept, but those rows no longer name an account.",
    "Any key scoped to it loses a candidate — the router refuses the delete and names those keys rather than narrowing them silently.",
    needsOperator(account.status)
      ? "This account already needs an operator; disabling it keeps the id and the history."
      : "Disable is the non-destructive door: it keeps the id, the pool membership and the joinable history.",
  ]
}
