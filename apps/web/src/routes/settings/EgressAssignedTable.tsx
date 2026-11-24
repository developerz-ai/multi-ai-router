import { createMemo, Show } from "solid-js"
import { StatusDot } from "../../components/StatusDot"
import { type Column, Table } from "../../components/Table"
import type { EgressAssignment, EgressOverview, ProxyCheck } from "../../lib/api/egress"
import { providerDisplayName } from "../../lib/provider-display"
import { useTestAccountProxy } from "../../lib/queries/egress"
import { createRowRuns } from "../../lib/row-runs"
import styles from "../egress/egress.module.scss"
import { replaceable, vendorNote } from "../egress/egress-copy"
import { ProxyHealth } from "../egress/ProxyHealth"
import { ProxyTest } from "../egress/ProxyTest"
import { ReplaceModeField } from "../egress/ReplaceModeField"

/** An account and the proxy it has now: a replaced one takes its test result with it. */
const runKey = (row: EgressAssignment) => `${row.account.id} ${row.address}`

/** Every account that leaves through a proxy, and how that proxy is doing. */
export function EgressAssignedTable(props: {
  readonly overview: EgressOverview
  readonly nowMs: number
}) {
  const test = useTestAccountProxy()
  const runs = createRowRuns<ProxyCheck>()
  const listed = createMemo(() => new Set(props.overview.proxies.map((proxy) => proxy.address)))

  const press = (row: EgressAssignment) => {
    // Read now: `row` follows the poll, and this answer is about the proxy that was tested.
    const tested = { accountId: row.account.id, address: row.address }
    void runs.run(runKey(row), () => test.mutateAsync(tested))
  }

  const columns: readonly Column<EgressAssignment>[] = [
    {
      id: "account",
      header: "Account",
      cell: (row) => (
        <div class={styles.stack}>
          <span class={styles.name}>{row.account.label}</span>
          <span class={styles.sub}>{providerDisplayName(row.account.provider)}</span>
          <StatusDot status={row.account.status} />
        </div>
      ),
    },
    {
      id: "proxy",
      header: "Proxy",
      cell: (row) => (
        <div class={styles.stack}>
          <span class={styles.address}>{row.address}</span>
          <span class={styles.sub}>
            {row.vendor ?? "custom"}
            {row.country === null ? "" : ` · ${row.country}`}
          </span>
          <Show when={vendorNote(row)}>{(note) => <span class={styles.warn}>{note()}</span>}</Show>
        </div>
      ),
    },
    {
      id: "health",
      header: "Health",
      cell: (row) => <ProxyHealth assignment={row} nowMs={props.nowMs} />,
    },
    {
      id: "replace",
      header: "Dead proxy",
      cell: (row) => (
        <ReplaceModeField
          accountId={row.account.id}
          accountLabel={row.account.label}
          mode={row.replace}
          replaceable={replaceable(row, listed())}
        />
      ),
    },
    {
      id: "test",
      header: "Test",
      cell: (row) => (
        <ProxyTest
          busy={runs.pending().has(runKey(row))}
          error={runs.errors().get(runKey(row))}
          label={`Test the proxy of ${row.account.label} now`}
          nowMs={props.nowMs}
          onTest={() => press(row)}
          result={runs.results().get(runKey(row))}
        />
      ),
    },
  ]

  return (
    <Table
      caption="Accounts behind a proxy. A check opens a tunnel towards the account's own upstream and closes it; nothing is sent to an AI provider."
      columns={columns}
      emptyMessage="No account uses a proxy. Set one in an account's Edit dialog."
      rowId={(row) => row.account.id}
      rows={props.overview.assigned}
    />
  )
}
