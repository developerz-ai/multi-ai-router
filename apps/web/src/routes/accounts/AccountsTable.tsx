import { Show } from "solid-js"
import { Button } from "../../components/Button"
import { ResetIndicator } from "../../components/ResetIndicator"
import { StatusDot } from "../../components/StatusDot"
import { type Column, Table } from "../../components/Table"
import { hasSpentWindow } from "../../lib/account-status"
import type { TestAccountInput } from "../../lib/api/accounts"
import type { AccountView, ProviderDescriptor } from "../../lib/api/types"
import { billingConsequence } from "../../lib/billing"
import { formatDate, formatRelative, formatTimestamp } from "../../lib/format"
import { parseInstant } from "../../lib/quota-windows"
import type { UsageRowSummary } from "../../lib/usage-index"
import { usageFor } from "../../lib/usage-index"
import { AccountModels } from "./AccountModels"
import { AccountRecheck } from "./AccountRecheck"
import styles from "./AccountsTable.module.scss"
import { AccountTestNow } from "./AccountTestNow"
import { connectLabel } from "./account-cells"
import { CredentialCell } from "./CredentialCell"
import { TrafficCell } from "./TrafficCell"

export interface AccountsTableProps {
  readonly accounts: readonly AccountView[]
  readonly nowMs: number
  /** Names the table for its region landmark. Per provider group, so seven tables have seven names. */
  readonly caption?: string
  /** The id currently being re-checked, if any. */
  readonly recheckingId: string | null
  /** The id currently being tested, if any. */
  readonly testingId: string | null
  /** The id whose model catalog is currently being discovered, if any. */
  readonly discoveringId: string | null
  /**
   * This account's provider as `GET /providers` describes it — which login it takes, and whether it
   * needs a credential at all. Asked of the descriptor so no provider fact is restated here.
   */
  readonly providerFor: (account: AccountView) => ProviderDescriptor | undefined
  /** Per-account usage for the selected window, indexed by account id. */
  readonly usage: ReadonlyMap<string, UsageRowSummary>
  readonly usageBucket: "hour" | "day"
  readonly usageLoading: boolean
  readonly usageWindowLabel: string
  readonly onRecheck: (id: string) => void
  readonly onTest: (input: TestAccountInput) => void
  readonly onDiscoverModels: (id: string) => void
  readonly onConnect: (account: AccountView) => void
  readonly onEdit: (account: AccountView) => void
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
          {/*
            Only the subscription case is marked, and it rides in this cell rather than taking a
            column of its own: `metered` is what almost every account is and a badge on all of them
            would be noise, while a subscription changes how every cost figure on this row must be
            read — notional, never summed with spend.
          */}
          <Show when={account.billing === "subscription"}>
            <span class={styles.provider} title={billingConsequence("subscription")}>
              subscription · notional cost
            </span>
          </Show>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (account) => (
        <div class={styles.status}>
          <StatusDot status={account.status} />
          {/* A spent window blocks routing exactly like a breaker does, but leaves the status
              green — so the block is stated here, at headline level, not only in the window
              sub-row an operator has to know to open. `spent` is the server's verdict, the same
              one candidate filtering reaches. */}
          <Show
            when={account.status === "active" && hasSpentWindow(account.availability?.quotaWindows)}
          >
            <span class={styles.spentNote}>window spent — not routable</span>
          </Show>
        </div>
      ),
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
          // `parseInstant`, never a bare `Date.parse`: a malformed instant must become "no
          // instant", not a NaN that renders as "Invalid Date" beside "in 0s".
          resetsAt={parseInstant(account.availability?.resetsAt ?? null)}
          status={account.status}
        />
      ),
    },
    {
      // Traffic and spend in one compact column: "no traffic" for a silent row, otherwise the
      // trend, the count and both spend figures with their meaning on hover. The keys table keeps
      // the two-column form; here twelve columns compete for the width.
      id: "usage",
      header: `Usage · ${props.usageWindowLabel}`,
      cell: (account) => (
        <TrafficCell
          bucket={props.usageBucket}
          label={`Requests per ${props.usageBucket} for account ${account.label}`}
          loading={props.usageLoading}
          usage={usageFor(props.usage, account.id)}
        />
      ),
    },
    {
      // For a Claude subscription this is the login's lifetime — plan badge, "valid until"
      // with countdown, or "expired — reconnect" with the button inline. See `CredentialCell`.
      id: "credential",
      header: "Credential / login",
      cell: (account) => (
        <CredentialCell
          account={account}
          nowMs={props.nowMs}
          onReconnect={props.onConnect}
          provider={props.providerFor(account)}
        />
      ),
    },
    {
      id: "routing",
      header: "Weight / prio",
      numeric: true,
      cell: (account) => `${account.weight} / ${account.priority}`,
    },
    {
      id: "models",
      header: "Models",
      cell: (account) => (
        <AccountModels
          accountId={account.id}
          busy={props.discoveringId === account.id}
          models={account.supportedModels}
          onDiscover={props.onDiscoverModels}
          transport={props.providerFor(account)?.transport}
        />
      ),
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
      id: "test",
      header: "Test",
      cell: (account) => (
        <AccountTestNow
          accountId={account.id}
          busy={props.testingId === account.id}
          nowMs={props.nowMs}
          onTest={props.onTest}
          transport={props.providerFor(account)?.transport}
        />
      ),
    },
    {
      // One column, two lifecycle facts. "Last used" is the operator's only view of the
      // `last_used_at` column the idle probe reads: it is how "pooled but never selected" and
      // "the usage stamping actually works" become visible without a database shell. Relative
      // time in the cell, absolute on hover — and null is the word "never", not a blank.
      id: "created",
      header: "Added / last used",
      cell: (account) => (
        <div class={styles.identity}>
          <span class={styles.muted}>{formatDate(account.createdAt)}</span>
          <span
            class={styles.muted}
            title={
              account.lastUsedAt === null || account.lastUsedAt === undefined
                ? "Never served a request — or not since the router began recording last use."
                : formatTimestamp(account.lastUsedAt)
            }
          >
            used {formatRelative(account.lastUsedAt ?? null, props.nowMs)}
          </span>
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (account) => (
        <div class={styles.actions}>
          {/* Re-authorising is the same row, not a delete and re-add: the id, the config
              directory, the pool membership and the usage history all survive it. */}
          <Show when={props.providerFor(account)?.connectFlow}>
            <Button
              onClick={() => props.onConnect(account)}
              size="sm"
              tone={account.status === "needs_reauth" ? "primary" : "neutral"}
            >
              {connectLabel(account)}
            </Button>
          </Show>
          {/* Label, credential rotation, endpoint, dialect, model set and routing numbers —
              all of it editable in place, so a rotated key is not a delete and re-add. */}
          <Button onClick={() => props.onEdit(account)} size="sm" tone="neutral">
            Edit
          </Button>
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
      caption={
        props.caption ??
        "Upstream accounts. Reset is shown as absolute time and countdown, labelled by how much the instant can be trusted."
      }
      columns={columns()}
      rowId={(account) => account.id}
      rows={props.accounts}
    />
  )
}
