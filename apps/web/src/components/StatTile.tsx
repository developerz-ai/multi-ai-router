import { Show } from "solid-js"
import { Skeleton } from "./Skeleton"
import styles from "./StatTile.module.scss"

export interface StatTileProps {
  readonly label: string
  /** Absent means not loaded yet — the tile renders its skeleton. */
  readonly value?: string
  /** Sub-line: the window the figure covers, or what qualifies it. */
  readonly note?: string
}

/**
 * A single headline figure. Numbers use tabular figures so a row of tiles keeps
 * its baselines and digit widths aligned.
 */
export function StatTile(props: StatTileProps) {
  return (
    <div aria-busy={props.value === undefined ? "true" : "false"} class={styles.tile}>
      <span class={styles.label}>{props.label}</span>
      <Show fallback={<Skeleton height="1.75rem" width="4.5rem" />} when={props.value}>
        {(value) => <span class={styles.value}>{value()}</span>}
      </Show>
      <Show fallback={<Skeleton height="0.75rem" width="6rem" />} when={props.note}>
        {(note) => <span class={styles.note}>{note()}</span>}
      </Show>
    </div>
  )
}
