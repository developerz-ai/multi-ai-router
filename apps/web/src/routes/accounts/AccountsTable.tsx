import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { ResetIndicator } from "../../components/ResetIndicator"
import { StatusDot } from "../../components/StatusDot"
import { type Column, Table } from "../../components/Table"
import { UsageCell } from "../../components/UsageCell"
import type { AccountView, ProviderConnectFlow } from "../../lib/api/types"
import { formatDate } from "../../lib/format"
import type { UsageRowSummary } from "../../lib/usage-index"
import { usageFor } from "../../lib/usage-index"
import { AccountRecheck } from "./AccountRecheck"
import styles from "./AccountsTable.module.scss"

export interface AccountsTableProps {
  readonly accounts: readonly AccountView[]
  readonly nowMs: number
  /** The id currently being re-checked, if any. */
  readonly recheckingId: string | null
  /** Which login this account's provider takes, or null for one that takes none. */
  readonly connectFlowFor: (account: AccountView) => ProviderConnectFlow | null
  /** Per-account usage for the selected window, indexed by account id. */
  readonly usage: ReadonlyMap<string, UsageRowSummary>
  readonly usageBucket: "hour" | "day"
  readonly usageLoading: boolean
  readonly usageWindowLabel: string
  readonly onRecheck: (id: string) => void
  readonly onConnect: (account: AccountView) => void
  readonly onDisable: (account: AccountView) => void
  readonly onEnable: (account: AccountView) => void
  readonly onDelete: (account: AccountView) => void
}

/**
 * One row per upstream account. The identity column is pinned by `Table`, so a
 * horizontal scroll on a phone never loses which account a number belongs to.
 *
 * The availability column renders **one row per quota window** rather than a
 * single reset: a Claude subscription runs five on independent clocks and is
 * blocked by whichever is spent, so a lone "resets at" would name one of them
 * and drop the other four. An account whose provider exposes no windows falls
 * back to the account-level line, which is the whole story for an API key.
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
          label={account.label}
          nowMs={props.nowMs}
          quotaWindows={account.availability?.quotaWindows ?? []}
          resetSource={account.availability?.resetSource ?? "unknown"}
          resetsAt={
            account.availability?.resetsAt === undefined || account.availability.resetsAt === null
              ? null
              : Date.parse(account.availability.resetsAt)
          }
          status={account.status}
        />
      ),
    },
    {
      id: "usage",
      header: `Usage · ${props.usageWindowLabel}`,
      cell: (account) => (
        <UsageCell
          bucket={props.usageBucket}
          label={`Requests per ${props.usageBucket} for account ${account.label}`}
          loading={props.usageLoading}
          usage={usageFor(props.usage, account.id)}
        />
      ),
    },
    {
      id: "credential",
      header: "Credential",
      cell: (account) => (
        <Show
          fallback={
            <Badge
              tone={account.hasCredential ? "ok" : "warn"}
              title={credentialHint(account, props.connectFlowFor(account))}
            >
              {credentialLabel(account, props.connectFlowFor(account))}
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
          lastCheckedAt={account.availability?.lastCheckedAt ?? null}
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
          {/* Re-authorising is the same row, not a delete and re-add: the id, the config
              directory, the pool membership and the usage history all survive it. */}
          <Show when={props.connectFlowFor(account) !== null}>
            <Button
              onClick={() => props.onConnect(account)}
              size="sm"
              tone={account.status === "needs_reauth" ? "primary" : "neutral"}
            >
              {connectLabel(account)}
            </Button>
          </Show>
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
      caption="Upstream accounts. Reset is shown as absolute time and countdown, labelled by how much the instant can be trusted."
      columns={columns()}
      rowId={(account) => account.id}
      rows={props.accounts}
    />
  )
}

/**
 * "Missing" and "not connected" are different problems with different fixes. An API-key account
 * with no credential needs someone to paste one; a subscription with none needs a login run. The
 * word decides which button the operator reaches for.
 */
function credentialLabel(account: AccountView, flow: ProviderConnectFlow | null): string {
  if (account.hasCredential) return "stored"
  return flow === null ? "missing" : "not connected"
}

function credentialHint(account: AccountView, flow: ProviderConnectFlow | null): string {
  if (account.hasCredential) return "A credential is stored, encrypted. No endpoint returns it."
  if (flow === null) return "No credential stored — this account cannot serve a request."
  return "No authorization yet — run Connect. Nothing is pasted by hand for this provider."
}

/**
 * "Connect" while the router holds no authorization for this account, "Reconnect" after.
 *
 * A Claude subscription always reads "Connect", and that is a stated limitation rather than a
 * default: the router holds no credential for one — the Agent SDK owns it inside the account's
 * `CLAUDE_CONFIG_DIR` and we deliberately never read it — so nothing here can tell a logged-in
 * subscription from a fresh row, and picking the confident word would be a guess.
 *
 * Both words drive the same call against the same row. The id, the config directory, the pool
 * membership and the usage history survive either; only the audit kind differs.
 */
function connectLabel(account: AccountView): "Connect" | "Reconnect" {
  return account.hasCredential ? "Reconnect" : "Connect"
}
