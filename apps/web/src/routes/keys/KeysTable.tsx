import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { type Column, Table } from "../../components/Table"
import { UsageCell } from "../../components/UsageCell"
import type { ApiKeyView } from "../../lib/api/types"
import { formatDate, formatRelative, formatWindow } from "../../lib/format"
import type { UsageRowSummary } from "../../lib/usage-index"
import { usageFor } from "../../lib/usage-index"
import styles from "./KeysTable.module.scss"

export interface KeysTableProps {
  readonly keys: readonly ApiKeyView[]
  readonly nowMs: number
  /** The id currently being revealed, if any. */
  readonly revealingId: string | null
  /** Per-key usage for the selected window, indexed by key id. */
  readonly usage: ReadonlyMap<string, UsageRowSummary>
  readonly usageBucket: "hour" | "day"
  readonly usageLoading: boolean
  /** The window these figures cover, for the column header — "7 days". */
  readonly usageWindowLabel: string
  readonly onReveal: (key: ApiKeyView) => void
  readonly onRevoke: (key: ApiKeyView) => void
  readonly onDelete: (key: ApiKeyView) => void
}

/**
 * One row per router key.
 *
 * The identity column shows the name and the **stored display prefix** — never
 * the value. A screenshot of this table leaks nothing; the value lives behind
 * an audited `POST /keys/:id/reveal`, which the Reveal action calls.
 *
 * Usage is a column here rather than a trip to the usage screen: "which key is
 * burning the budget" is the question an operator arrives at this table with,
 * and answering it elsewhere means holding two screens side by side. Metered and
 * notional spend are printed apart in that cell and never summed.
 */
export function KeysTable(props: KeysTableProps) {
  const columns = (): readonly Column<ApiKeyView>[] => [
    {
      id: "name",
      header: "Name",
      cell: (key) => (
        <div class={styles.identity}>
          <span class={styles.name}>{key.name}</span>
          <span class={styles.prefix}>{key.prefix}…</span>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: (key) => (
        <Show fallback={<Badge tone="ok">active</Badge>} when={key.revoked}>
          <Badge title={`Revoked ${formatDate(key.revokedAt)}`} tone="danger">
            revoked
          </Badge>
        </Show>
      ),
    },
    {
      id: "scope",
      header: "Scope",
      cell: (key) => <span class={styles.scope}>{describeScope(key)}</span>,
    },
    {
      id: "limit",
      header: "Rate limit",
      cell: (key) => (
        <Show fallback={<span class={styles.muted}>none</span>} when={key.rateLimit}>
          {(limit) => (
            <span class={styles.muted}>
              {limit().requests} / {formatWindow(limit().windowSeconds)}
            </span>
          )}
        </Show>
      ),
    },
    {
      id: "usage",
      header: `Usage · ${props.usageWindowLabel}`,
      cell: (key) => (
        <UsageCell
          bucket={props.usageBucket}
          label={`Requests per ${props.usageBucket} for key ${key.name}`}
          loading={props.usageLoading}
          usage={usageFor(props.usage, key.id)}
        />
      ),
    },
    {
      id: "lastUsed",
      header: "Last used",
      cell: (key) => (
        <span class={styles.muted}>{formatRelative(key.lastUsedAt, props.nowMs)}</span>
      ),
    },
    {
      id: "expires",
      header: "Expires",
      cell: (key) => (
        <span class={styles.muted}>
          {key.expiresAt === null ? "never" : formatDate(key.expiresAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: (key) => (
        <div class={styles.actions}>
          <Button
            busy={props.revealingId === key.id}
            onClick={() => props.onReveal(key)}
            size="sm"
            tone="neutral"
          >
            Reveal
          </Button>
          <Show when={!key.revoked}>
            <Button onClick={() => props.onRevoke(key)} size="sm" tone="danger">
              Revoke
            </Button>
          </Show>
          <Button onClick={() => props.onDelete(key)} size="sm" tone="danger">
            Delete
          </Button>
        </div>
      ),
    },
  ]

  return (
    <Table
      caption="Router keys. Values stay readable — select Reveal on any row."
      columns={columns()}
      rowId={(key) => key.id}
      rows={props.keys}
    />
  )
}

/** Scope is enforced upstream as an intersection; this only counts the targets. */
function describeScope(key: ApiKeyView): string {
  switch (key.scope.kind) {
    case "all":
      return "all accounts"
    case "pools":
      return `${key.scope.poolIds.length} pool(s)`
    case "accounts":
      return `${key.scope.accountIds.length} account(s)`
  }
}
