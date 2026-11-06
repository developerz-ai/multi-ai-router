import { Show } from "solid-js"
import { Button } from "../../components/Button"
import { EmptyState } from "../../components/EmptyState"

export interface AccountsEmptyProps {
  /** A filter emptied the page, which is a different problem from an empty fleet. */
  readonly filtered: boolean
  readonly onAdd: () => void
  readonly onClear: () => void
}

/** The accounts page with no rows: offers the way out of the filter when a filter is the cause. */
export function AccountsEmpty(props: AccountsEmptyProps) {
  return (
    <EmptyState
      action={
        <Show
          fallback={
            <Button onClick={() => props.onAdd()} tone="primary">
              Add account
            </Button>
          }
          when={props.filtered}
        >
          <Button onClick={() => props.onClear()} tone="neutral">
            Clear filters
          </Button>
        </Show>
      }
      description={
        props.filtered
          ? "Accounts exist outside this status and provider. Clear the filters to see them."
          : "An account is one upstream subscription or API key. Attach several of the same provider — the router pools them behind one endpoint and picks between them per request."
      }
      icon="accounts"
      title={props.filtered ? "No accounts match this filter" : "No accounts yet"}
    />
  )
}
