import { For, Show } from "solid-js"
import { Banner } from "../../components/Banner"
import { Button } from "../../components/Button"
import type { DiscoverModelsResult } from "../../lib/api/accounts"
import { errorMessage } from "../../lib/api/errors"
import type { RowRuns } from "../../lib/row-runs"
import { DiscoverKeptNotice } from "./DiscoverKeptNotice"

/** A row action's failures, by account. */
type Failures = Pick<RowRuns<unknown>, "errors" | "reset">

export interface AccountsNoticesProps {
  readonly recheck: Failures
  readonly recheckAll: { readonly isError: boolean; readonly error: unknown }
  readonly test: Failures
  /** A row's Enable. Null while the edit dialog is open, which shows its own errors. */
  readonly enableError: unknown
  readonly discover: Failures & Pick<RowRuns<DiscoverModelsResult>, "results">
  readonly labelFor: (accountId: string) => string
}

/**
 * The page-level verdicts that have no cell of their own. A failed press has to say so somewhere:
 * the button's cell has room for a state, not for a reason, and "could not read the model listing:
 * …" is the whole diagnosis.
 */
export function AccountsNotices(props: AccountsNoticesProps) {
  return (
    <>
      <RowFailures labelFor={props.labelFor} of={props.recheck} title="Re-check failed" />
      <RowFailures labelFor={props.labelFor} of={props.test} title="Test could not run" />
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
      <RowFailures labelFor={props.labelFor} of={props.discover} title="Model discovery failed" />
      <For each={[...props.discover.results().values()]}>
        {(result) => (
          <>
            {/* Mounted only with ids to show, so the removal it owns exists only while offered. */}
            <Show when={result.notInCatalogue.length > 0}>
              <DiscoverKeptNotice
                accountId={result.accountId}
                message={`${props.labelFor(result.accountId)} — ${result.message}`}
                notInCatalogue={result.notInCatalogue}
                onRemoved={() => props.discover.reset(result.accountId)}
              />
            </Show>
            <Show when={!result.saved}>
              <Banner
                action={
                  <Button
                    onClick={() => props.discover.reset(result.accountId)}
                    size="sm"
                    tone="neutral"
                  >
                    Dismiss
                  </Button>
                }
                title={`The upstream listed no models: ${props.labelFor(result.accountId)}`}
                tone="warn"
              >
                {result.message}
              </Banner>
            </Show>
          </>
        )}
      </For>
    </>
  )
}

/** One banner per account, each with its own way off the screen. */
function RowFailures(props: {
  readonly title: string
  readonly of: Failures
  readonly labelFor: (accountId: string) => string
}) {
  return (
    <For each={[...props.of.errors().keys()]}>
      {(id) => (
        <Banner
          action={
            <Button onClick={() => props.of.reset(id)} size="sm" tone="neutral">
              Dismiss
            </Button>
          }
          title={`${props.title}: ${props.labelFor(id)}`}
          tone="danger"
        >
          {errorMessage(props.of.errors().get(id))}
        </Banner>
      )}
    </For>
  )
}
