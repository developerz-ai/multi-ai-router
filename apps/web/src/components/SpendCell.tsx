import { Show } from "solid-js"
import { formatCost } from "../lib/format"
import type { UsageRowSummary } from "../lib/usage-index"
import styles from "./SpendCell.module.scss"

export interface SpendCellProps {
  readonly usage: UsageRowSummary
  /** True while the usage query is still in flight. Renders a dash, never a zero. */
  readonly loading?: boolean
}

/**
 * One row's spend, in a table cell of its own. Cost is always its own column, never
 * part of the usage cell: crammed in beside the sparkline it overflowed the column and
 * painted through the neighbouring credential pill (issue #62).
 *
 * **Metered and notional are printed apart and never added.** Metered is real money from a priced
 * model; notional is attributed spend on a flat-fee subscription account, where the invoice does
 * not move when the number does. A single "cost" column summing them would report money that was
 * never billed, which is the one number an operator would forward to finance.
 *
 * **A pending query renders "—", not "0".** Zero is a measurement — it says this key served
 * nothing all week — and showing it before the data lands makes a busy key look idle.
 */
export function SpendCell(props: SpendCellProps) {
  return (
    <Show fallback={<span class={styles.pending}>—</span>} when={props.loading !== true}>
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
    </Show>
  )
}
