import { For, type JSX, mergeProps, Show } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./Table.module.scss"

export interface Column<T> {
  /** Stable identity for the column; also the `<For>` key. */
  readonly id: string
  readonly header: string
  readonly cell: (row: T) => JSX.Element
  /** Right-aligned, tabular figures. Every measure column wants this. */
  readonly numeric?: boolean
}

export interface TableProps<T> {
  readonly columns: readonly Column<T>[]
  readonly rows: readonly T[]
  readonly rowId: (row: T) => string
  /** Shown above the header; describes what the numbers are. */
  readonly caption?: string
  readonly emptyMessage?: string
}

/**
 * The table shell every list surface renders through — accounts, pools, keys,
 * usage leaderboards. It owns structure, alignment and the empty state, and
 * nothing else: no sorting, no fetching, no pagination until a second caller
 * needs them.
 *
 * `<For>` is keyed by reference, which is what a list of rows wants: a row
 * object that did not change is not re-rendered. `<Index>` would be wrong here
 * — position is not the identity of a row.
 */
export function Table<T>(props: TableProps<T>) {
  const merged = mergeProps({ emptyMessage: "Nothing here yet." }, props)

  return (
    <div class={styles.scroller}>
      <table class={styles.table}>
        <Show when={merged.caption}>
          {(caption) => <caption class={styles.caption}>{caption()}</caption>}
        </Show>
        <thead>
          <tr>
            <For each={merged.columns}>
              {(column) => (
                <th
                  class={cx(styles.headCell, column.numeric === true && styles.numeric)}
                  scope="col"
                >
                  {column.header}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <Show
            when={merged.rows.length > 0}
            fallback={
              <tr>
                <td class={styles.empty} colSpan={merged.columns.length}>
                  {merged.emptyMessage}
                </td>
              </tr>
            }
          >
            <For each={merged.rows}>
              {(row) => (
                <tr class={styles.row} data-row-id={merged.rowId(row)}>
                  <For each={merged.columns}>
                    {(column) => (
                      <td class={cx(styles.cell, column.numeric === true && styles.numeric)}>
                        {column.cell(row)}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  )
}
