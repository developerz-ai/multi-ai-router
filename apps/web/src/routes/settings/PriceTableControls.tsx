import { Show } from "solid-js"
import { Button } from "../../components/Button"
import { TextField } from "../../components/Field"
import { PRICE_PAGE_SIZE } from "../../lib/price-filter"
import styles from "./PriceTableControls.module.scss"

export interface PriceTableControlsProps {
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly showAll: boolean
  readonly onShowAll: (showAll: boolean) => void
  /** From `visiblePriceRows`: what the table currently shows against what matched. */
  readonly shown: number
  readonly matched: number
  readonly hidden: number
  readonly total: number
}

/**
 * The search box and the fold toggle above the price table. Keyboard-native: an input and a
 * button, no custom widget. The count line is a live region so a screen-reader user typing a
 * model id hears the table narrow.
 */
export function PriceTableControls(props: PriceTableControlsProps) {
  const searching = () => props.query.trim() !== ""

  return (
    <div class={styles.root}>
      <TextField
        autocomplete="off"
        label="Find a model or provider"
        onInput={(event) => props.onQuery(event.currentTarget.value)}
        placeholder="claude-sonnet, openrouter, …"
        type="search"
        value={props.query}
      />
      <p aria-live="polite" class={styles.count}>
        <Show
          fallback={
            <>
              {props.shown} of {props.total} rows
            </>
          }
          when={searching()}
        >
          {props.matched} of {props.total} rows match
        </Show>
        <Show when={props.hidden > 0}> · {props.hidden} folded</Show>
      </p>
      <Show when={!searching() && props.hidden > 0}>
        <Button onClick={() => props.onShowAll(true)} size="sm" tone="neutral">
          Show all {props.total}
        </Button>
      </Show>
      <Show when={!searching() && props.showAll && props.total > PRICE_PAGE_SIZE}>
        <Button onClick={() => props.onShowAll(false)} size="sm" tone="neutral">
          Fold to first {PRICE_PAGE_SIZE}
        </Button>
      </Show>
    </div>
  )
}
