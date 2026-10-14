import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { SpendCell } from "../../components/SpendCell"
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
  readonly onEdit: (key: ApiKeyView) => void
  /** Mints a fresh key carrying this one's attribution — see the action's comment. */
  readonly onMintSuccessor: (key: ApiKeyView) => void
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
 * and answering it elsewhere means holding two screens side by side. Spend rides
 * beside it in the COST column, metered and notional printed apart and never summed.
 */
export function KeysTable(props: KeysTableProps) {
  const columns = (): readonly Column<ApiKeyView>[] => [
    {
      id: "name",
      header: "Name",
      cell: (key) => (
        <div class={styles.identity}>
          <span class={styles.name}>{key.name}</span>
          <Show when={attributionLine(key)}>
            {(line) => <span class={styles.attribution}>{line()}</span>}
          </Show>
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
      // Cost keeps its own column here; the accounts table instead folds both
      // spend figures into its usage cell (TrafficCell, #94), where its eleven
      // columns compete for the width and this table's nine do not. What survives both
      // layouts: metered and notional are printed apart, never summed.
      id: "cost",
      header: `Cost · ${props.usageWindowLabel}`,
      cell: (key) => (
        <SpendCell loading={props.usageLoading} usage={usageFor(props.usage, key.id)} />
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
          {/* Name, scope, ceiling and expiry are editable in place — the value never
              changes, so every client holding this key keeps working across the edit. */}
          <Button onClick={() => props.onEdit(key)} size="sm" tone="neutral">
            Edit
          </Button>
          {/* Rotation without orphaning the attribution: a successor is a fresh key
              that opens the mint form prefilled with this one's owner, tool, purpose,
              scope and ceiling. The name starts empty and the value is never shown. */}
          <Button onClick={() => props.onMintSuccessor(key)} size="sm" tone="neutral">
            Mint successor
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

/** "owner / tool" for the identity cell — whichever halves the key carries, or nothing at all. */
function attributionLine(key: ApiKeyView): string | null {
  const parts = [key.owner, key.tool].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(" / ")
}
