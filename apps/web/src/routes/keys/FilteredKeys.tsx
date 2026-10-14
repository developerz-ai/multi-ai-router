import { Show, splitProps } from "solid-js"
import { Button } from "../../components/Button"
import type { ApiKeyView } from "../../lib/api/types"
import styles from "./FilteredKeys.module.scss"
import { distinctOwners, distinctTools, filterKeys, liveSelection } from "./filter-keys"
import { KeyFilters } from "./KeyFilters"
import { KeysTable, type KeysTableProps } from "./KeysTable"

export interface FilteredKeysProps extends Omit<KeysTableProps, "keys"> {
  /** The full, unfiltered list: the chips name every owner and tool in it. */
  readonly rows: readonly ApiKeyView[]
  /** The raw selections. The caller owns them so they outlive a remount on refetch. */
  readonly ownerFilter: string | null
  readonly toolFilter: string | null
  readonly onOwnerFilterChange: (owner: string | null) => void
  readonly onToolFilterChange: (tool: string | null) => void
}

/**
 * The owner/tool chips and the table they narrow.
 *
 * A chip whose value has left the list stops filtering (see `liveSelection`), and
 * the underlying selection is cleared too: leaving it set would let the filter
 * silently come back the moment a key carrying that value reappeared.
 */
export function FilteredKeys(props: FilteredKeysProps) {
  const [own, table] = splitProps(props, [
    "rows",
    "ownerFilter",
    "toolFilter",
    "onOwnerFilterChange",
    "onToolFilterChange",
  ])

  const owner = () => liveSelection(own.ownerFilter, distinctOwners(own.rows))
  const tool = () => liveSelection(own.toolFilter, distinctTools(own.rows))
  const visible = () => filterKeys(own.rows, owner(), tool())

  const clearFilters = () => {
    own.onOwnerFilterChange(null)
    own.onToolFilterChange(null)
  }

  return (
    <>
      <KeyFilters
        keys={own.rows}
        onOwnerChange={own.onOwnerFilterChange}
        onToolChange={own.onToolFilterChange}
        owner={owner()}
        tool={tool()}
      />
      <Show
        fallback={
          // Reaching zero rows through the chips is not "no keys yet" —
          // the fleet is right there behind the filter, and the operator
          // needs the toggle, not an empty state, to get back to it.
          <div class={styles.filterEmpty} role="status">
            <p>No keys carry the selected owner and tool together.</p>
            <Button onClick={clearFilters}>Clear filters</Button>
          </div>
        }
        when={visible().length > 0}
      >
        <KeysTable {...table} keys={visible()} />
      </Show>
    </>
  )
}
