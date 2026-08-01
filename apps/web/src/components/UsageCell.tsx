import { Show } from "solid-js"
import { formatCount } from "../lib/format"
import type { UsageRowSummary } from "../lib/usage-index"
import { Sparkline } from "./Sparkline"
import styles from "./UsageCell.module.scss"

export interface UsageCellProps {
  readonly usage: UsageRowSummary
  /** Names the trend for assistive tech — "Requests per day for key acme-ci". */
  readonly label: string
  readonly bucket: "hour" | "day"
  /** True while the usage query is still in flight. Renders a dash, never a zero. */
  readonly loading?: boolean
}

/**
 * One row's traffic, in a table cell: the trend and the request count. Spend is
 * deliberately NOT here — it renders beside this cell in its own COST column
 * (`SpendCell`), because crammed together the pair overflowed the column and
 * painted through the neighbouring cell (issue #62).
 *
 * **A pending query renders "—", not "0".** Zero is a measurement — it says this key served
 * nothing all week — and showing it before the data lands makes a busy key look idle.
 */
export function UsageCell(props: UsageCellProps) {
  return (
    <Show fallback={<span class={styles.pending}>—</span>} when={props.loading !== true}>
      <div class={styles.root}>
        <Sparkline label={props.label} points={props.usage.series} />

        <div class={styles.figures}>
          <span class={styles.requests}>{formatCount(props.usage.requests)}</span>
          <span class={styles.unit}>req / {props.bucket}</span>
        </div>
      </div>
    </Show>
  )
}
