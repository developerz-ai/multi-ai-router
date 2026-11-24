import { createSignal, Show } from "solid-js"
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

/** Every account that leaves through a proxy, and how that proxy is doing. */
export function EgressAssignedTable(props: {
  readonly overview: EgressOverview
  readonly nowMs: number
}) {
  const test = useTestAccountProxy()
  const runs = createRowRuns<ProxyCheck>()
  const [checks, setChecks] = createSignal<Readonly<Record<string, ProxyCheck | undefined>>>({})
  const [errors, setErrors] = createSignal<Readonly<Record<string, unknown>>>({})

  const press = (id: string) => {
    setErrors((current) => ({ ...current, [id]: undefined }))
    void runs.run(id, () => test.mutateAsync(id), {
      onSuccess: (check) => setChecks((current) => ({ ...current, [id]: check })),
      onError: (error) => setErrors((current) => ({ ...current, [id]: error })),
    })
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
          replaceable={replaceable(row, props.overview.proxies)}
        />
      ),
    },
    {
      id: "test",
      header: "Test",
      cell: (row) => (
        <ProxyTest
          busy={runs.pending().has(row.account.id)}
          error={errors()[row.account.id]}
          label={`Test the proxy of ${row.account.label} now`}
          nowMs={props.nowMs}
          onTest={() => press(row.account.id)}
          result={checks()[row.account.id]}
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
