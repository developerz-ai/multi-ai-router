import { createSignal, For, Show } from "solid-js"
import { Button } from "../../components/Button"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { QueryBoundary } from "../../components/QueryBoundary"
import { TableSkeleton } from "../../components/TableSkeleton"
import { errorMessage } from "../../lib/api/errors"
import { loadedData } from "../../lib/loaded"
import { useProviders } from "../../lib/queries/providers"
import { useSavePriceOverrides, useSettings } from "../../lib/queries/settings"
import { PriceAddForm } from "./PriceAddForm"
import { PriceCoverage } from "./PriceCoverage"
import styles from "./PriceOverridesSection.module.scss"
import { PriceTable } from "./PriceTable"
import { PriceTableControls } from "./PriceTableControls"
import { removalConsequences, summarise } from "./price-editing"
import { createPriceState } from "./price-state"

/** Edit overrides locally; Save atomically replaces the stored account/provider/model set. */
export function PriceOverridesSection() {
  const settings = useSettings()
  const providers = useProviders()
  const save = useSavePriceOverrides()

  const state = createPriceState(() => loadedData(settings)?.prices)
  const [accountId, setAccountId] = createSignal("")
  const [provider, setProvider] = createSignal("")
  const [model, setModel] = createSignal("")
  const [addError, setAddError] = createSignal<string | null>(null)
  const [confirming, setConfirming] = createSignal(false)

  const providerList = () => loadedData(providers) ?? []

  const discard = () => {
    state.discard()
    setAddError(null)
    save.reset()
  }

  const add = () => {
    const chosen = providerList().find((descriptor) => descriptor.id === provider())
    if (chosen === undefined || model().trim().length === 0) {
      setAddError("Pick a provider and name a model.")
      return
    }
    const refused = state.add(chosen, model(), accountId())
    setAddError(refused)
    if (refused === null) setModel("")
  }

  const commit = () => {
    save.mutate(state.payload(), {
      onSuccess: () => {
        discard()
        setConfirming(false)
      },
    })
  }

  const attemptSave = () => {
    if (state.diff().removed.length > 0) setConfirming(true)
    else commit()
  }

  return (
    <section aria-labelledby="prices-heading" class={styles.section}>
      <h2 class={styles.heading} id="prices-heading">
        Price table
      </h2>
      <p class={styles.note}>
        Every rate is <strong>US dollars per million tokens</strong>. An override wins for the model
        it names and the shipped table stays the fallback for everything else, so correcting one
        stale rate never costs the rest of the table. A model priced by neither is reported as
        unknown spend — never as zero.
      </p>

      <QueryBoundary
        errorTitle="The price table could not be loaded"
        loading={<TableSkeleton label="Loading prices" rows={5} />}
        query={settings}
      >
        {(view) => (
          <>
            <PriceCoverage
              prices={view().prices}
              onPrice={(id, chosenProvider, name) => {
                setAccountId(id)
                setProvider(chosenProvider)
                setModel(name)
              }}
            />

            <PriceTableControls
              hidden={state.visible().hidden}
              matched={state.visible().matched}
              onQuery={state.setQuery}
              onShowAll={state.setShowAll}
              query={state.query()}
              showAll={state.showAll()}
              shown={state.visible().rows.length}
              total={state.rows().length}
            />

            <PriceTable
              accounts={view().prices.accounts}
              invalid={state.badCell}
              onEdit={state.edit}
              onRevert={state.revert}
              rows={state.visible().rows}
              value={state.cellValue}
            />

            <PriceAddForm
              accounts={view().prices.accounts}
              accountId={accountId()}
              onAccount={setAccountId}
              error={addError()}
              model={model()}
              onAdd={add}
              onModel={setModel}
              onProvider={(value) => {
                setProvider(value)
                setAccountId("")
              }}
              provider={provider()}
              providers={providerList()}
            />

            <Show when={state.unparseable().length > 0}>
              <p class={styles.error} role="alert">
                <For each={state.unparseable()}>
                  {(row) => (
                    <span class={styles.line}>
                      {row.provider} / {row.model} has a rate that is not a number of dollars.
                    </span>
                  )}
                </For>
                A price must be zero or more. Fix them, or discard the changes.
              </p>
            </Show>

            <Show when={save.isError}>
              <p class={styles.error} role="alert">
                {errorMessage(save.error)} Your edits are still here.
              </p>
            </Show>

            <div class={styles.bar}>
              <p class={styles.summary}>{summarise(view(), state.diff())}</p>
              <div class={styles.actions}>
                <Show when={state.touched()}>
                  <Button onClick={discard} tone="ghost">
                    Discard changes
                  </Button>
                </Show>
                <Button
                  busy={save.isPending}
                  disabled={!state.dirty() || state.unparseable().length > 0}
                  onClick={attemptSave}
                  tone="primary"
                >
                  Save price overrides
                </Button>
              </div>
            </div>

            <Show when={confirming()}>
              <ConfirmDialog
                busy={save.isPending}
                confirmLabel="Save and remove"
                consequences={removalConsequences(state.diff(), view().prices.shipped)}
                error={save.error}
                onClose={() => {
                  save.reset()
                  setConfirming(false)
                }}
                onConfirm={() => commit()}
                open
                subject={`${state.diff().removed.length} price override(s)`}
                title="This save removes price overrides"
              />
            </Show>
          </>
        )}
      </QueryBoundary>
    </section>
  )
}
