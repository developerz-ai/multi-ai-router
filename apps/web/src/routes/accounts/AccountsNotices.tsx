import { Show } from "solid-js"
import { Banner } from "../../components/Banner"
import { errorMessage } from "../../lib/api/errors"

interface Outcome<T> {
  readonly isError: boolean
  readonly error: unknown
  readonly isSuccess: boolean
  readonly data: T | undefined
}

export interface AccountsNoticesProps {
  readonly recheck: Outcome<unknown>
  readonly recheckAll: Outcome<unknown>
  readonly test: Outcome<unknown>
  /** A row's Enable. Null while the edit dialog is open, which shows its own errors. */
  readonly enableError: unknown
  readonly discover: Outcome<{ readonly saved: boolean; readonly message: string }>
}

/**
 * The page-level verdicts that have no cell of their own. A failed press has to say so somewhere:
 * the button's cell has room for a state, not for a reason, and "could not read the model listing:
 * …" is the whole diagnosis.
 */
export function AccountsNotices(props: AccountsNoticesProps) {
  return (
    <>
      <Show when={props.recheck.isError}>
        <Banner title="Re-check failed" tone="danger">
          {errorMessage(props.recheck.error)}
        </Banner>
      </Show>

      <Show when={props.test.isError}>
        <Banner title="Test could not run" tone="danger">
          {errorMessage(props.test.error)}
        </Banner>
      </Show>

      <Show when={props.enableError !== null && props.enableError !== undefined}>
        <Banner title="Enable failed" tone="danger">
          {errorMessage(props.enableError)}
        </Banner>
      </Show>

      <Show when={props.recheckAll.isError}>
        <Banner title="Re-check all failed" tone="danger">
          {errorMessage(props.recheckAll.error)}
        </Banner>
      </Show>

      <Show when={props.discover.isError}>
        <Banner title="Model discovery failed" tone="danger">
          {errorMessage(props.discover.error)}
        </Banner>
      </Show>

      <Show when={props.discover.isSuccess && props.discover.data?.saved === false}>
        <Banner title="The upstream listed no models" tone="warn">
          {props.discover.data?.message}
        </Banner>
      </Show>
    </>
  )
}
