import { createSignal } from "solid-js"
import { Badge } from "../../components/Badge"
import { type Column, Table } from "../../components/Table"
import type { EgressProxyChoice, ProxyCheck } from "../../lib/api/egress"
import { formatRelative } from "../../lib/format"
import { useTestProxy } from "../../lib/queries/egress"
import { createRowRuns } from "../../lib/row-runs"
import styles from "../egress/egress.module.scss"
import { ProxyTest } from "../egress/ProxyTest"

const rowKey = (proxy: EgressProxyChoice) => `${proxy.vendor}/${proxy.id}`

/** Every proxy the configured vendors list, and who uses each. */
export function EgressInventoryTable(props: {
  readonly proxies: readonly EgressProxyChoice[]
  readonly nowMs: number
}) {
  const test = useTestProxy()
  const runs = createRowRuns<ProxyCheck>()
  const [checks, setChecks] = createSignal<Readonly<Record<string, ProxyCheck | undefined>>>({})
  const [errors, setErrors] = createSignal<Readonly<Record<string, unknown>>>({})

  const press = (proxy: EgressProxyChoice) => {
    const key = rowKey(proxy)
    setErrors((current) => ({ ...current, [key]: undefined }))
    void runs.run(key, () => test.mutateAsync({ vendor: proxy.vendor, id: proxy.id }), {
      onSuccess: (check) => setChecks((current) => ({ ...current, [key]: check })),
      onError: (error) => setErrors((current) => ({ ...current, [key]: error })),
    })
  }

  const columns: readonly Column<EgressProxyChoice>[] = [
    {
      id: "address",
      header: "Proxy",
      cell: (proxy) => (
        <div class={styles.stack}>
          <span class={styles.address}>{proxy.address}</span>
          <span class={styles.sub}>
            {proxy.location === "" ? proxy.vendor : `${proxy.vendor} · ${proxy.location}`}
          </span>
        </div>
      ),
    },
    {
      id: "vendor",
      header: "Vendor says",
      cell: (proxy) => (
        <div class={styles.stack}>
          <span>
            <Badge tone={proxy.valid ? "ok" : "danger"}>{proxy.valid ? "valid" : "invalid"}</Badge>
          </span>
          <span class={styles.sub}>
            verified {formatRelative(proxy.lastVerifiedAt, props.nowMs)}
          </span>
        </div>
      ),
    },
    {
      id: "accounts",
      header: "Used by",
      cell: (proxy) =>
        proxy.accounts.length === 0
          ? "—"
          : proxy.accounts.map((account) => account.label).join(", "),
    },
    {
      id: "test",
      header: "Test",
      cell: (proxy) => (
        <ProxyTest
          busy={runs.pending().has(rowKey(proxy))}
          error={errors()[rowKey(proxy)]}
          label={`Test proxy ${proxy.address} now`}
          nowMs={props.nowMs}
          onTest={() => press(proxy)}
          result={checks()[rowKey(proxy)]}
        />
      ),
    },
  ]

  return (
    <Table
      caption="Proxies the configured vendors list. An unused one is what a dead proxy is replaced with."
      columns={columns}
      rowId={rowKey}
      rows={props.proxies}
    />
  )
}
