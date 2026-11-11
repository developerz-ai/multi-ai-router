import {
  type Accessor,
  createMemo,
  createUniqueId,
  For,
  type JSX,
  mergeProps,
  Show,
} from "solid-js"
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
 * Rows are keyed by `rowId`, never by object reference. A poll or a keystroke
 * hands the table fresh row objects for the same rows (a refetch parses a new
 * body; the price editor re-derives every row per keystroke), and a
 * reference-keyed `<For>` would dispose and recreate each `<tr>` — losing the
 * focused input, the half-typed value, the open confirm. `<Index>` would be
 * wrong too: position is not the identity of a row.
 */
export function Table<T>(props: TableProps<T>) {
  const merged = mergeProps({ emptyMessage: "Nothing here yet." }, props)
  const captionId = createUniqueId()

  // A landmark with no accessible name is worse than no landmark, so the role
  // and the name are produced together or not at all — one object, never two
  // independent attributes that could drift apart.
  const ids = createMemo(() => merged.rows.map((row) => merged.rowId(row)))
  const byId = createMemo(() => new Map(merged.rows.map((row) => [merged.rowId(row), row])))

  const region = createMemo(() =>
    merged.caption === undefined ? {} : ({ role: "region", "aria-labelledby": captionId } as const),
  )

  return (
    // `tabindex` makes the scroll region reachable by keyboard — a scroll
    // container that only a pointer can move is a WCAG 2.1.1 failure.
    <div {...region()} class={styles.scroller} tabindex="0">
      <table class={styles.table}>
        <Show when={merged.caption}>
          {(caption) => (
            <caption class={styles.caption} id={captionId}>
              {caption()}
            </caption>
          )}
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
            <For each={ids()}>
              {(id) => {
                const row = liveRow(latestRow(id, byId))
                return (
                  <tr class={styles.row} data-row-id={id}>
                    <For each={merged.columns}>
                      {(column) => (
                        <td class={cx(styles.cell, column.numeric === true && styles.numeric)}>
                          {column.cell(row)}
                        </td>
                      )}
                    </For>
                  </tr>
                )
              }}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  )
}

/** The current object for one row id; the last one seen while the row is being removed. */
function latestRow<T>(id: string, byId: Accessor<ReadonlyMap<string, T>>): Accessor<T> {
  let last: T | undefined
  return () => {
    const current = byId().get(id)
    if (current !== undefined) last = current
    if (last === undefined) throw new Error(`Table row ${id} has no data`)
    return last
  }
}

/**
 * A stand-in row whose every property read goes to the row's latest object.
 *
 * `column.cell(row)` runs once per row, so a cell's components and inputs survive a replaced row
 * object; the reads inside its JSX are tracked through this proxy, so the text still updates. A
 * cell that returns a plain value re-runs because its insert reads through the proxy too.
 */
function liveRow<T>(current: Accessor<T>): T {
  const target = () => current() as object
  return new Proxy(
    {},
    {
      get: (_, key) => Reflect.get(target(), key),
      has: (_, key) => Reflect.has(target(), key),
      ownKeys: () => Reflect.ownKeys(target()),
      getOwnPropertyDescriptor: (_, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target(), key)
        return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
      },
    },
  ) as T
}
