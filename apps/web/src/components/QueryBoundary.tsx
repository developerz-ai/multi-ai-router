import type { UseQueryResult } from "@tanstack/solid-query"
import { type JSX, Match, Switch } from "solid-js"
import { ErrorState } from "./ErrorState"
import { TableSkeleton } from "./TableSkeleton"

export interface QueryBoundaryProps<T> {
  readonly query: UseQueryResult<T, Error>
  /** What failed, for the error card — "Accounts could not be loaded". */
  readonly errorTitle: string
  /** Shaped like the content it stands in for. Defaults to a table skeleton. */
  readonly loading?: JSX.Element
  readonly children: (data: T) => JSX.Element
}

/**
 * The three states every read surface has, in one place: loading, failed,
 * loaded. Writing them out per route is how one screen ends up with a spinner,
 * another with a blank, and a third with a raw status code.
 *
 * **`query.data` is read only inside the success branch.** In `solid-query`,
 * `data` is backed by a resource: reading it while the query is pending
 * suspends the nearest `<Suspense>` — which for a lazily-imported route is the
 * router's own boundary, and the skeleton below would never render. `<Match>`
 * evaluates its children only when its condition holds, so the read happens
 * strictly after the resource has resolved.
 */
export function QueryBoundary<T>(props: QueryBoundaryProps<T>) {
  return (
    <Switch>
      <Match when={props.query.isPending}>{props.loading ?? <TableSkeleton />}</Match>
      <Match when={props.query.isError}>
        <ErrorState
          error={props.query.error}
          onRetry={() => void props.query.refetch()}
          retrying={props.query.isFetching}
          title={props.errorTitle}
        />
      </Match>
      <Match when={props.query.isSuccess}>{props.children(props.query.data as T)}</Match>
    </Switch>
  )
}
