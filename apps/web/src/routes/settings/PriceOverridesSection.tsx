import { createSignal, For, Show } from "solid-js"
import { Button } from "../../components/Button"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { QueryBoundary } from "../../components/QueryBoundary"
import { TableSkeleton } from "../../components/TableSkeleton"
import { errorMessage } from "../../lib/api/errors"
import {
  buildPriceOverridePayload,
  diffOverrides,
  type ModelRates,
  mergePriceRows,
  type OverrideDiff,
  type PriceRow,
  priceRowId,
  type RateField,
  type SettingsView,
  withRates,
} from "../../lib/api/settings"
import { useProviders } from "../../lib/queries/providers"
import { useSavePriceOverrides, useSettings } from "../../lib/queries/settings"
import { PriceAddForm } from "./PriceAddForm"
import styles from "./PriceOverridesSection.module.scss"
import { PriceTable } from "./PriceTable"
import {
  draftOf,
  EMPTY_DRAFT,
  parseDraft,
  type RateDraft,
  removalConsequences,
  summarise,
  toRate,
  ZERO_RATES,
} from "./price-editing"

/**
 * The price table: shipped rows and operator overrides in one list.
 *
 * Three rules this section exists to hold.
 *
 * **Nothing is saved until Save is pressed.** Every edit is a signal here; the
 * edits survive a failed save, because losing a table of typed numbers to a 400
 * is worse than the 400.
 *
 * **The PATCH is the complete set.** Removing an override means sending a list
 * without it, so the confirmation names every row that disappears and what each
 * one falls back to — a shipped price, or no price at all.
 *
 * **Editing state lives outside the `QueryBoundary`.** The boundary re-runs its
 * children whenever the query resolves again, so state held inside would be wiped
 * by a background refetch mid-edit.
 */
export function PriceOverridesSection() {
  const settings = useSettings()
  const providers = useProviders()
  const save = useSavePriceOverrides()

  const [drafts, setDrafts] = createSignal<Readonly<Record<string, RateDraft>>>({})
  const [extras, setExtras] = createSignal<readonly PriceRow[]>([])
  const [dropped, setDropped] = createSignal<readonly string[]>([])
  const [provider, setProvider] = createSignal("")
  const [model, setModel] = createSignal("")
  const [addError, setAddError] = createSignal<string | null>(null)
  const [confirming, setConfirming] = createSignal(false)

  // A row added in this session sits at the end until the save lands and the
  // server's ordering takes over — a just-added row must not be hard to find.
  const rows = (view: SettingsView): readonly PriceRow[] =>
    [...mergePriceRows(view.prices.shipped, view.prices.overrides), ...extras()]
      .filter((row) => !dropped().includes(row.id))
      .map((row) => withRates(row, edited(row)))

  const edited = (row: PriceRow): ModelRates => {
    const draft = drafts()[row.id]
    return draft === undefined ? row.rates : (parseDraft(draft) ?? row.rates)
  }

  const diffFor = (view: SettingsView): OverrideDiff =>
    diffOverrides(view.prices.overrides, buildPriceOverridePayload(rows(view)))

  const dirty = (view: SettingsView): boolean => {
    const diff = diffFor(view)
    return diff.removed.length > 0 || diff.changed.length > 0
  }

  const unparseable = (view: SettingsView): readonly PriceRow[] =>
    rows(view).filter((row) => {
      const draft = drafts()[row.id]
      return draft !== undefined && parseDraft(draft) === null
    })

  const cellValue = (row: PriceRow, field: RateField): string =>
    drafts()[row.id]?.[field] ?? String(row.rates[field])

  const badCell = (row: PriceRow, field: RateField): boolean => {
    const draft = drafts()[row.id]
    return draft !== undefined && toRate(draft[field]) === null
  }

  const edit = (row: PriceRow, field: RateField, value: string) => {
    setDrafts((current) => ({
      ...current,
      [row.id]: { ...(current[row.id] ?? draftOf(row.rates)), [field]: value },
    }))
  }

  const revert = (row: PriceRow) => {
    const shipped = row.shipped
    if (shipped === null) {
      // An extension has nothing to revert to: removing it un-prices the model.
      setExtras((current) => current.filter((extra) => extra.id !== row.id))
      setDropped((current) => (current.includes(row.id) ? current : [...current, row.id]))
      return
    }
    setDrafts((current) => ({ ...current, [row.id]: draftOf(shipped) }))
  }

  const discard = () => {
    setDrafts({})
    setExtras([])
    setDropped([])
    setAddError(null)
    save.reset()
  }

  const providerList = () => (providers.isSuccess ? (providers.data ?? []) : [])

  const add = (view: SettingsView) => {
    const chosen = providerList().find((descriptor) => descriptor.id === provider())
    // Normalised here because `price_overrides` indexes a trimmed, lowercased
    // model name — two casings of one model must not become two rows.
    const name = model().trim().toLowerCase()
    if (chosen === undefined || name.length === 0) {
      setAddError("Pick a provider and name a model.")
      return
    }

    const id = priceRowId(chosen.id, name)
    if (rows(view).some((row) => row.id === id)) {
      setAddError(`${chosen.id} / ${name} is already listed — edit its row instead.`)
      return
    }

    setExtras((current) => [
      ...current,
      {
        id,
        provider: chosen.id,
        model: name,
        origin: "added",
        shipped: null,
        rates: ZERO_RATES,
        longContext: null,
        updatedAt: null,
      },
    ])
    setDrafts((current) => ({ ...current, [id]: EMPTY_DRAFT }))
    setDropped((current) => current.filter((value) => value !== id))
    setModel("")
    setAddError(null)
  }

  const commit = (view: SettingsView) => {
    save.mutate(buildPriceOverridePayload(rows(view)), {
      onSuccess: () => {
        discard()
        setConfirming(false)
      },
    })
  }

  const attemptSave = (view: SettingsView) => {
    if (diffFor(view).removed.length > 0) {
      setConfirming(true)
      return
    }
    commit(view)
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
            <p class={styles.note}>
              The shipped rates were last checked against their vendors on{" "}
              <strong>{view.prices.shippedAsOf}</strong>. They ship inside the image and a vendor
              reprices without asking, so anything newer than that date is the operator's to correct
              here.
            </p>

            <PriceTable
              invalid={badCell}
              onEdit={edit}
              onRevert={revert}
              rows={rows(view)}
              value={cellValue}
            />

            <PriceAddForm
              error={addError()}
              model={model()}
              onAdd={() => add(view)}
              onModel={setModel}
              onProvider={setProvider}
              provider={provider()}
              providers={providerList()}
            />

            <Show when={unparseable(view).length > 0}>
              <p class={styles.error} role="alert">
                <For each={unparseable(view)}>
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
              <p class={styles.summary}>{summarise(view, diffFor(view))}</p>
              <div class={styles.actions}>
                <Show when={dirty(view)}>
                  <Button onClick={discard} tone="ghost">
                    Discard changes
                  </Button>
                </Show>
                <Button
                  busy={save.isPending}
                  disabled={!dirty(view) || unparseable(view).length > 0}
                  onClick={() => attemptSave(view)}
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
                consequences={removalConsequences(diffFor(view), view.prices.shipped)}
                error={save.error}
                onClose={() => {
                  save.reset()
                  setConfirming(false)
                }}
                onConfirm={() => commit(view)}
                open
                subject={`${diffFor(view).removed.length} price override(s)`}
                title="This save removes price overrides"
              />
            </Show>
          </>
        )}
      </QueryBoundary>
    </section>
  )
}
