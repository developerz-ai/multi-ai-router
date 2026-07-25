import { Show } from "solid-js"
import { formatCost, formatCount } from "../lib/format"
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
 * One row's traffic, in a table cell: the trend, the request count, and spend.
 *
 * **Metered and notional are printed apart and never added.** Metered is real money from a priced
 * model; notional is attributed spend on a flat-fee subscription account, where the invoice does
 * not move when the number does. A single "cost" column summing them would report money that was
 * never billed, which is the one number an operator would forward to finance.
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

        <dl class={styles.spend}>
          <div class={styles.spendRow}>
            <dt class={styles.spendLabel} title="Real money, from a priced model.">
              metered
            </dt>
            <dd class={styles.spendValue}>{formatCost(props.usage.costMetered)}</dd>
          </div>
          <div class={styles.spendRow}>
            <dt
              class={styles.spendLabel}
              title="Attributed spend on a subscription account. Not billed, and never added to metered."
            >
              notional
            </dt>
            <dd class={styles.spendValue}>{formatCost(props.usage.costNotional)}</dd>
          </div>
        </dl>
      </div>
    </Show>
  )
}
