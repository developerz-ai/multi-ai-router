import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { ResetIndicator } from "../../components/ResetIndicator"
import { StatusDot } from "../../components/StatusDot"
import { type Column, Table } from "../../components/Table"
import type { AccountView } from "../../lib/api/types"
import { formatDate } from "../../lib/format"
import { AccountRecheck } from "./AccountRecheck"
import styles from "./AccountsTable.module.scss"

export interface AccountsTableProps {
  readonly accounts: readonly AccountView[]
  readonly nowMs: number
  /** The id currently being re-checked, if any. */
  readonly recheckingId: string | null
  readonly onRecheck: (id: string) => void
  readonly onDisable: (account: AccountView) => void
  readonly onEnable: (account: AccountView) => void
  readonly onDelete: (account: AccountView) => void
}

/**
 * One row per upstream account. The identity column is pinned by `Table`, so a
 * horizontal scroll on a phone never loses which account a number belongs to.
 *
 * **Reset carries no live quota data yet.** `AccountView` has no quota-window
 * state on it, so `resetsAt` is null and the source is `unknown` — which
 * `describeReset` renders as "Unknown — will retry with backoff" for a cooling
 * account and "needs top-up" for an exhausted one. Both are true statements
 * today. When the API carries `QuotaWindowState`, the values feed straight into
 * the same component and the countdown appears.
 */
export function AccountsTable(props: AccountsTableProps) {
  const columns = (): readonly Column<AccountView>[] => [
    {
      id: "label",
      header: "Account",
      cell: (account) => (
        <div class={styles.identity}>
          <span class={styles.label}>{account.label}</span>
          <span class={styles.provider}>{account.provider}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (account) => <StatusDot status={account.status} />,
    },
    {
      id: "reset",
      header: "Availability",
      cell: (account) => (
        <ResetIndicator
          nowMs={props.nowMs}
          resetSource="unknown"
          resetsAt={null}
          status={account.status}
        />
      ),
    },
    {
      id: "credential",
      header: "Credential",
      cell: (account) => (
        <Show
          fallback={
            <Badge tone={account.hasCredential ? "ok" : "warn"} title={credentialHint(account)}>
              {account.hasCredential ? "stored" : "missing"}
            </Badge>
          }
          when={account.configDir}
        >
          {(dir) => (
            <Badge title={`Agent SDK config directory: ${dir()}`} tone="accent">
              config dir
            </Badge>
          )}
        </Show>
      ),
    },
    {
      id: "routing",
      header: "Weight / priority",
      numeric: true,
      cell: (account) => `${account.weight} / ${account.priority}`,
    },
    {
      id: "recheck",
      header: "Re-check",
      cell: (account) => (
        <AccountRecheck
          accountId={account.id}
          busy={props.recheckingId === account.id}
          nowMs={props.nowMs}
          onRecheck={props.onRecheck}
        />
      ),
    },
    {
      id: "created",
      header: "Added",
      cell: (account) => <span class={styles.muted}>{formatDate(account.createdAt)}</span>,
    },
    {
      id: "actions",
      header: "Actions",
      cell: (account) => (
        <div class={styles.actions}>
          <Show
            fallback={
              <Button onClick={() => props.onEnable(account)} size="sm" tone="neutral">
                Enable
              </Button>
            }
            when={account.status !== "disabled"}
          >
            <Button onClick={() => props.onDisable(account)} size="sm" tone="neutral">
              Disable
            </Button>
          </Show>
          <Button onClick={() => props.onDelete(account)} size="sm" tone="danger">
            Delete
          </Button>
        </div>
      ),
    },
  ]

  return (
    <Table
      caption="Upstream accounts. Reset is shown as absolute time and countdown once quota state is on the wire."
      columns={columns()}
      rowId={(account) => account.id}
      rows={props.accounts}
    />
  )
}

function credentialHint(account: AccountView): string {
  return account.hasCredential
    ? "A credential is stored, encrypted. No endpoint returns it."
    : "No credential stored — this account cannot serve a request."
}
