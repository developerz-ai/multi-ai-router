import { createSignal, For, Show } from "solid-js"
import { Badge } from "../components/Badge"
import { Button } from "../components/Button"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { EmptyState } from "../components/EmptyState"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { StatusDot } from "../components/StatusDot"
import { type Column, Table } from "../components/Table"
import { TableSkeleton } from "../components/TableSkeleton"
import { isRoutable } from "../lib/account-status"
import type { PoolView } from "../lib/api/types"
import { useAllAccounts } from "../lib/queries/accounts"
import { useCreatePool, useDeletePool, usePools, useUpdatePool } from "../lib/queries/pools"
import styles from "./PoolsRoute.module.scss"
import { PoolFormDialog } from "./pools/PoolFormDialog"

/**
 * Pools: which accounts a key can reach through one name, and how the router
 * picks between them.
 *
 * The column that earns its place is **Routable** — how many members are
 * eligible right now against how many are in the pool. A pool of five with one
 * routable member is a pool about to become an outage, and a membership count
 * alone does not say that.
 */
export default function PoolsRoute() {
  const pools = usePools()
  const accounts = useAllAccounts()
  const create = useCreatePool()
  const update = useUpdatePool()
  const remove = useDeletePool()

  const [editing, setEditing] = createSignal<PoolView | null>(null)
  const [formOpen, setFormOpen] = createSignal(false)
  const [pendingDelete, setPendingDelete] = createSignal<PoolView | null>(null)

  const accountList = () => (accounts.isSuccess ? (accounts.data ?? []) : [])
  const accountLabel = (id: string): string =>
    accountList().find((account) => account.id === id)?.label ?? id

  const openCreate = () => {
    create.reset()
    update.reset()
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (pool: PoolView) => {
    create.reset()
    update.reset()
    setEditing(pool)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
  }

  const closeDelete = () => {
    remove.reset()
    setPendingDelete(null)
  }

  const columns: readonly Column<PoolView>[] = [
    {
      id: "name",
      header: "Pool",
      cell: (pool) => <span class={styles.name}>{pool.name}</span>,
    },
    {
      id: "policy",
      header: "Policy",
      cell: (pool) => <Badge tone="accent">{pool.policy}</Badge>,
    },
    {
      id: "routable",
      header: "Routable",
      numeric: true,
      cell: (pool) => `${routableCount(pool)} / ${pool.members.length}`,
    },
    {
      id: "members",
      header: "Members",
      cell: (pool) => (
        <Show
          fallback={<span class={styles.muted}>No members</span>}
          when={pool.members.length > 0}
        >
          <ul class={styles.members}>
            <For each={pool.members}>
              {(member) => (
                <li class={styles.member}>
                  <StatusDot compact status={member.status} />
                  <span>{member.label}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      ),
    },
    {
      id: "overflow",
      header: "Overflow",
      cell: (pool) => (
        <Show fallback={<span class={styles.muted}>—</span>} when={pool.overflowAccountId}>
          {(id) => <span class={styles.muted}>{accountLabel(id())}</span>}
        </Show>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (pool) => (
        <div class={styles.actions}>
          <Button onClick={() => openEdit(pool)} size="sm" tone="neutral">
            Edit
          </Button>
          <Button onClick={() => setPendingDelete(pool)} size="sm" tone="danger">
            Delete
          </Button>
        </div>
      ),
    },
  ]

  return (
    <>
      <PageHeader
        actions={
          <Button onClick={openCreate} tone="primary">
            New pool
          </Button>
        }
        subtitle="A pool turns a set of accounts into one addressable, more reliable thing a key points at."
        title="Pools"
      />

      <QueryBoundary
        errorTitle="Pools could not be loaded"
        loading={<TableSkeleton label="Loading pools" rows={3} />}
        query={pools}
      >
        {(rows) => (
          <Show
            fallback={
              <EmptyState
                action={
                  <Button onClick={openCreate} tone="primary">
                    New pool
                  </Button>
                }
                description="Point a key at a pool instead of at one account and the router fails over between its members on your policy. A key scoped to 'all' works without any pool at all."
                icon="pools"
                title="No pools yet"
              />
            }
            when={rows.length > 0}
          >
            <Table
              caption="Pools, their policy, and how many members are eligible right now."
              columns={columns}
              rowId={(pool) => pool.id}
              rows={rows}
            />
          </Show>
        )}
      </QueryBoundary>

      <PoolFormDialog
        accounts={accountList()}
        busy={create.isPending || update.isPending}
        error={editing() === null ? create.error : update.error}
        onClose={closeForm}
        onSubmit={(input) => {
          const target = editing()
          if (target === null) {
            create.mutate(input, { onSuccess: closeForm })
            return
          }
          update.mutate({ id: target.id, patch: input }, { onSuccess: closeForm })
        }}
        open={formOpen()}
        pool={editing()}
      />

      <Show when={pendingDelete()}>
        {(pool) => (
          <ConfirmDialog
            busy={remove.isPending}
            confirmLabel="Delete pool"
            consequences={deleteConsequences(pool())}
            error={remove.error}
            onClose={closeDelete}
            onConfirm={() => remove.mutate(pool().id, { onSuccess: closeDelete })}
            open
            subject={pool().name}
            title="Delete this pool?"
          />
        )}
      </Show>
    </>
  )
}

function routableCount(pool: PoolView): number {
  return pool.members.filter((member) => isRoutable(member.status)).length
}

/** Exactly what breaks. The 409 the server may answer with names the keys. */
function deleteConsequences(pool: PoolView): readonly string[] {
  return [
    `The ${pool.members.length} membership(s) in "${pool.name}" are removed. The accounts themselves are untouched.`,
    "Any key scoped to this pool loses those candidates — and a key left scoped to nothing fails every request.",
    "The router refuses the delete while any key names this pool, and says which ones. Re-scope them first.",
  ]
}
