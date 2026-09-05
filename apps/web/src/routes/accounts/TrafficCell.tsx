import { Show } from "solid-js"
import { Sparkline } from "../../components/Sparkline"
import { formatCost, formatCount } from "../../lib/format"
import type { UsageRowSummary } from "../../lib/usage-index"
import styles from "./TrafficCell.module.scss"

export interface TrafficCellProps {
  readonly usage: UsageRowSummary
  /** Names the trend for assistive tech — "Requests per day for account claude-max-1". */
  readonly label: string
  readonly bucket: "hour" | "day"
  /** True while the usage query is still in flight. Renders a dash, never a zero. */
  readonly loading?: boolean
}

/**
 * One row's traffic and spend in a single compact column — the accounts table's answer to
 * "is this account carrying anything", where twelve columns already compete for the width.
 *
 * Three states, each honest: **pending** is a dash (zero is a measurement, not a placeholder);
 * **no traffic** is the words, not a sparkline of nothing beside two `$0.00`s; and a served row
 * shows the trend, the count, and the two spend figures with their meaning on hover — *metered*
 * is real money, *notional* is attributed spend on a subscription, and they are never summed.
 */
export function TrafficCell(props: TrafficCellProps) {
  const silent = () =>
    props.usage.requests === 0 && props.usage.costMetered === 0 && props.usage.costNotional === 0

  return (
    <Show fallback={<span class={styles.muted}>—</span>} when={props.loading !== true}>
      <Show fallback={<span class={styles.muted}>no traffic</span>} when={!silent()}>
        <div class={styles.root}>
          <Sparkline label={props.label} points={props.usage.series} />
          <div class={styles.figures}>
            <span class={styles.requests}>
              {formatCount(props.usage.requests)}
              <span class={styles.unit}> req / {props.bucket}</span>
            </span>
            <span class={styles.spend}>
              <span title="Metered — real money, from a priced model.">
                {formatCost(props.usage.costMetered)}
              </span>
              <span aria-hidden="true"> · </span>
              <span
                class={styles.notional}
                title="Notional — attributed spend on a subscription account. Not billed, never added to metered."
              >
                {formatCost(props.usage.costNotional)} notional
              </span>
            </span>
          </div>
        </div>
      </Show>
    </Show>
  )
}
