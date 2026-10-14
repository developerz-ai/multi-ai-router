import { createMemo, For, Show } from "solid-js"
import type { ApiKeyView } from "../../lib/api/types"
import { distinctOwners, distinctTools } from "./filter-keys"
import styles from "./KeyFilters.module.scss"

export interface KeyFiltersProps {
  /** The full list, not the filtered one — the chips name every owner and tool there is. */
  readonly keys: readonly ApiKeyView[]
  readonly owner: string | null
  readonly tool: string | null
  readonly onOwnerChange: (owner: string | null) => void
  readonly onToolChange: (tool: string | null) => void
}

/**
 * Owner and tool chips above the keys table.
 *
 * Toggles, not pickers: pressing the active chip clears it, so there is always a
 * one-gesture way back to every row. Real `<button>`s, so they are keyboard
 * reachable and focus-visible through the global reset — no div-with-onClick.
 */
export function KeyFilters(props: KeyFiltersProps) {
  const owners = createMemo(() => distinctOwners(props.keys))
  const tools = createMemo(() => distinctTools(props.keys))

  const toggle = (
    current: string | null,
    value: string,
    onChange: (next: string | null) => void,
  ): void => {
    onChange(current === value ? null : value)
  }

  return (
    <Show when={owners().length > 0 || tools().length > 0}>
      <div class={styles.filters}>
        <Show when={owners().length > 0}>
          <fieldset class={styles.group}>
            <legend class={styles.legend}>Owner</legend>
            <ul class={styles.chips}>
              <For each={owners()}>
                {(owner) => (
                  <li>
                    <button
                      aria-pressed={props.owner === owner}
                      class={styles.chip}
                      onClick={() => toggle(props.owner, owner, props.onOwnerChange)}
                      type="button"
                    >
                      {owner}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </fieldset>
        </Show>

        <Show when={tools().length > 0}>
          <fieldset class={styles.group}>
            <legend class={styles.legend}>Tool</legend>
            <ul class={styles.chips}>
              <For each={tools()}>
                {(tool) => (
                  <li>
                    <button
                      aria-pressed={props.tool === tool}
                      class={styles.chip}
                      onClick={() => toggle(props.tool, tool, props.onToolChange)}
                      type="button"
                    >
                      {tool}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </fieldset>
        </Show>
      </div>
    </Show>
  )
}
