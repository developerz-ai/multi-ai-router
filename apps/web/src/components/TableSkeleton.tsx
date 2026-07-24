import { For, mergeProps } from "solid-js"
import { Skeleton } from "./Skeleton"
import styles from "./TableSkeleton.module.scss"

export interface TableSkeletonProps {
  readonly rows?: number
  /** What is loading, announced once for the whole block. */
  readonly label?: string
}

/**
 * A loading table, shaped like the table it replaces so the page does not jump
 * when the rows arrive.
 *
 * `aria-busy` and the label live on the *container*: the individual bars are
 * `aria-hidden`, so a screen reader hears "loading accounts" once instead of
 * twenty-four grey boxes.
 */
export function TableSkeleton(props: TableSkeletonProps) {
  const merged = mergeProps({ rows: 4, label: "Loading" }, props)
  const rows = () => Array.from({ length: merged.rows }, (_, index) => index)

  return (
    <div aria-busy="true" aria-label={merged.label} class={styles.root} role="status">
      <div class={styles.head}>
        <Skeleton height="0.75rem" width="7rem" />
        <Skeleton height="0.75rem" width="4rem" />
      </div>
      <For each={rows()}>
        {() => (
          <div class={styles.row}>
            <Skeleton height="0.875rem" width="40%" />
            <Skeleton height="0.875rem" width="22%" />
            <Skeleton height="0.875rem" width="18%" />
          </div>
        )}
      </For>
    </div>
  )
}
