import type { UseQueryResult } from "@tanstack/solid-query"
import { type Accessor, type JSX, Show, untrack } from "solid-js"
import { loadedData } from "../lib/loaded"
import { ErrorState } from "./ErrorState"
import { TableSkeleton } from "./TableSkeleton"

export interface QueryBoundaryProps<T> {
  readonly query: UseQueryResult<T, Error>
  /** What failed, for the error card — "Accounts could not be loaded". */
  readonly errorTitle: string
  /** Shaped like the content it stands in for. Defaults to a table skeleton. */
  readonly loading?: JSX.Element
  /**
   * Called once per load, with an accessor: a refetch updates what the accessor returns, it does
   * not call this again. Passing the value instead rebuilt the whole screen on every poll.
   */
  readonly children: (data: Accessor<T>) => JSX.Element
}

/**
 * The states every read surface has, in one place: loading, failed, loaded, and loaded with a
 * failed refresh. Writing them out per route is how one screen ends up with a spinner, another
 * with a blank, and a third with a raw status code.
 *
 * **The children render once, not once per refetch.** They get an accessor and run untracked, so
 * a poll that lands new data flows into the mounted tree through fine-grained reads instead of
 * disposing it: a collapsed group, a half-typed input and keyboard focus all survive.
 *
 * **A failed refresh keeps them too.** The last reading stays on screen under a card that says it
 * is the last reading; only a query that never answered is replaced by its error.
 */
export function QueryBoundary<T>(props: QueryBoundaryProps<T>) {
  const failure = (title: string) => (
    <ErrorState
      error={props.query.error}
      onRetry={() => void props.query.refetch()}
      retrying={props.query.isFetching}
      title={title}
    />
  )

  return (
    <Show
      fallback={
        <Show fallback={props.loading ?? <TableSkeleton />} when={props.query.isError}>
          {failure(props.errorTitle)}
        </Show>
      }
      when={loadedData(props.query) !== undefined}
    >
      <Show when={props.query.isError}>
        {failure(`${props.errorTitle} — showing the last reading`)}
      </Show>
      {untrack(() => props.children(() => props.query.data as T))}
    </Show>
  )
}
