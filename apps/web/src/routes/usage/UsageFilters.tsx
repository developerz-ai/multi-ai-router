import { For, Show } from "solid-js"
import { Button } from "../../components/Button"
import {
  type UsageFilters as Filters,
  hasUsageFilters,
  NO_USAGE_FILTERS,
  USAGE_FILTER_NAMES,
  type UsageFilterName,
} from "../../lib/api/usage-params"
import type { UsageFilterOptions } from "../../lib/usage-filter-options"
import styles from "./UsageFilters.module.scss"

export interface UsageFiltersProps {
  readonly filters: Filters
  /** Everything a filter can be set to, selected values included. */
  readonly options: UsageFilterOptions
  readonly onChange: (filters: Filters) => void
}

const LABEL: Readonly<Record<UsageFilterName, string>> = {
  owner: "Owner",
  tool: "Tool",
  model: "Model",
}

const NOUN: Readonly<Record<UsageFilterName, string>> = {
  owner: "owners",
  tool: "tools",
  model: "models",
}

/**
 * Narrow the page to some owners, tools and models. Each is a multi-select; values within one
 * filter widen (alice or bob), and separate filters narrow (alice's, and on this tool).
 *
 * Native `<details>` and checkboxes rather than a custom listbox: both are keyboard operable and
 * announced correctly with nothing to get wrong, and the option lists can be long enough that an
 * always-open row of chips would push the figures off the screen.
 */
export function UsageFilters(props: UsageFiltersProps) {
  function toggle(name: UsageFilterName, value: string) {
    const current = props.filters[name]
    const next = current.includes(value)
      ? current.filter((existing) => existing !== value)
      : [...current, value]
    props.onChange({ ...props.filters, [name]: next })
  }

  return (
    <section aria-label="Usage filters" class={styles.bar}>
      <For each={USAGE_FILTER_NAMES}>
        {(name) => (
          <details class={styles.group}>
            <summary class={styles.summary}>
              {LABEL[name]}
              <Show when={props.filters[name].length > 0}>
                <span class={styles.count}>{props.filters[name].length}</span>
              </Show>
            </summary>
            <Options
              name={name}
              onToggle={(value) => toggle(name, value)}
              options={props.options[name]}
              selected={props.filters[name]}
            />
          </details>
        )}
      </For>
      <Show when={hasUsageFilters(props.filters)}>
        <Button onClick={() => props.onChange(NO_USAGE_FILTERS)} size="sm" tone="ghost">
          Clear filters
        </Button>
      </Show>
    </section>
  )
}

function Options(props: {
  readonly name: UsageFilterName
  readonly options: readonly string[]
  readonly selected: readonly string[]
  readonly onToggle: (value: string) => void
}) {
  return (
    <fieldset class={styles.options}>
      <legend class={styles.legend}>{LABEL[props.name]}</legend>
      <Show
        fallback={<p class={styles.empty}>No {NOUN[props.name]} in this window.</p>}
        when={props.options.length > 0}
      >
        <For each={props.options}>
          {(value) => (
            <label class={styles.option}>
              <input
                checked={props.selected.includes(value)}
                onChange={() => props.onToggle(value)}
                type="checkbox"
              />
              <span>{value}</span>
            </label>
          )}
        </For>
      </Show>
    </fieldset>
  )
}
