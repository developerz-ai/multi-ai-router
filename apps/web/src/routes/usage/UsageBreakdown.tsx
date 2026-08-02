import { Sparkline } from "../../components/Sparkline"
import { type Column, Table } from "../../components/Table"
import type { UsageBreakdownRow, UsageDimension } from "../../lib/api/usage"
import { usageDimensionLabel } from "../../lib/api/usage"
import { formatCost, formatCount, formatMillis, formatPercent } from "../../lib/format"
import styles from "./UsageBreakdown.module.scss"

export interface UsageBreakdownProps {
  readonly dimension: UsageDimension
  readonly rows: readonly UsageBreakdownRow[]
  readonly bucket: "hour" | "day"
}

/**
 * "Who burned what", one row per member of the chosen dimension.
 *
 * Three columns are pairs on purpose, and never a single figure:
 *
 * - **Requests / attempts.** A failover chain of three is one request and three
 *   attempts. Merging them hides exactly the failover the router exists to do.
 * - **Metered / notional cost.** A subscription account has no per-token price,
 *   only an attribution. Summing them would invent a bill.
 * - **Input / cache.** Total prompt size is input + cache read + cache write;
 *   showing one without the others misstates what was sent.
 */
export function UsageBreakdown(props: UsageBreakdownProps) {
  const columns = (): readonly Column<UsageBreakdownRow>[] => [
    {
      id: "label",
      header: usageDimensionLabel(props.dimension),
      cell: (row) => (
        <div class={styles.identity}>
          <span class={styles.label}>{row.label}</span>
          <span class={styles.note}>{row.note}</span>
        </div>
      ),
    },
    {
      id: "trend",
      header: "Trend",
      cell: (row) => (
        <Sparkline label={`Requests per ${props.bucket} for ${row.label}`} points={row.series} />
      ),
    },
    {
      id: "requests",
      header: "Requests",
      numeric: true,
      cell: (row) => formatCount(row.totals.requests),
    },
    {
      id: "attempts",
      header: "Attempts",
      numeric: true,
      cell: (row) => formatCount(row.totals.attempts),
    },
    {
      id: "errors",
      header: "Error rate",
      numeric: true,
      cell: (row) => formatPercent(row.totals.errors, row.totals.attempts),
    },
    {
      id: "tokensIn",
      header: "Input",
      numeric: true,
      cell: (row) => formatCount(row.totals.tokensIn),
    },
    {
      id: "cache",
      header: "Cache read / write",
      numeric: true,
      cell: (row) =>
        `${formatCount(row.totals.cacheReadTokens)} / ${formatCount(row.totals.cacheWriteTokens)}`,
    },
    {
      id: "tokensOut",
      header: "Output",
      numeric: true,
      cell: (row) => formatCount(row.totals.tokensOut),
    },
    {
      id: "metered",
      header: "Metered",
      numeric: true,
      cell: (row) => formatCost(row.totals.costMetered),
    },
    {
      id: "notional",
      header: "Notional",
      numeric: true,
      cell: (row) => formatCost(row.totals.costNotional),
    },
    {
      id: "latency",
      header: "p50 / p95",
      numeric: true,
      // Null renders as a dash, never as zero — a quiet row has no percentile, not a 0 ms one.
      cell: (row) =>
        `${formatMillis(row.totals.latencyP50Ms)} / ${formatMillis(row.totals.latencyP95Ms)}`,
    },
  ]

  return (
    <Table
      caption={`Totals by ${usageDimensionLabel(props.dimension).toLowerCase()}. Requests and attempts are separate measures; metered and notional cost are never summed.`}
      columns={columns()}
      emptyMessage="Nothing was routed in this window."
      rowId={(row) => row.id}
      rows={props.rows}
    />
  )
}
