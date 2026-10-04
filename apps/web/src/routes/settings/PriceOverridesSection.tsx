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
import { visiblePriceRows } from "../../lib/price-filter"
import { useProviders } from "../../lib/queries/providers"
import { useSavePriceOverrides, useSettings } from "../../lib/queries/settings"
import { PriceAddForm } from "./PriceAddForm"
import { PriceCoverage } from "./PriceCoverage"
import styles from "./PriceOverridesSection.module.scss"
import { PriceTable } from "./PriceTable"
import { PriceTableControls } from "./PriceTableControls"
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

/** Edit overrides locally; Save atomically replaces the stored account/provider/model set. */
export function PriceOverridesSection() {
  const settings = useSettings()
  const providers = useProviders()
  const save = useSavePriceOverrides()

  const [drafts, setDrafts] = createSignal<Readonly<Record<string, RateDraft>>>({})
  const [extras, setExtras] = createSignal<readonly PriceRow[]>([])
  const [dropped, setDropped] = createSignal<readonly string[]>([])
  const [accountId, setAccountId] = createSignal("")
  const [provider, setProvider] = createSignal("")
  const [model, setModel] = createSignal("")
  const [addError, setAddError] = createSignal<string | null>(null)
  const [confirming, setConfirming] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [showAll, setShowAll] = createSignal(false)

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

  // Folded to the first page unless searched or unfolded; an edited row is never folded away.
  const visible = (view: SettingsView) =>
    visiblePriceRows(rows(view), query(), showAll(), (row) => drafts()[row.id] !== undefined)

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
    if (shipped === null || row.preserveOverride) {
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

    const id = priceRowId(chosen.id, name, accountId() || null)
    if (rows(view).some((row) => row.id === id)) {
      setAddError(`${chosen.id} / ${name} is already listed — edit its row instead.`)
      return
    }

    setExtras((current) => [
      ...current,
      {
        id,
        accountId: accountId() || null,
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
            <PriceCoverage
              prices={view.prices}
              onPrice={(id, chosenProvider, name) => {
                setAccountId(id)
                setProvider(chosenProvider)
                setModel(name)
              }}
            />

            <PriceTableControls
              hidden={visible(view).hidden}
              matched={visible(view).matched}
              onQuery={setQuery}
              onShowAll={setShowAll}
              query={query()}
              showAll={showAll()}
              shown={visible(view).rows.length}
              total={rows(view).length}
            />

            <PriceTable
              accounts={view.prices.accounts}
              invalid={badCell}
              onEdit={edit}
              onRevert={revert}
              rows={visible(view).rows}
              value={cellValue}
            />

            <PriceAddForm
              accounts={view.prices.accounts}
              accountId={accountId()}
              onAccount={setAccountId}
              error={addError()}
              model={model()}
              onAdd={() => add(view)}
              onModel={setModel}
              onProvider={(value) => {
                setProvider(value)
                setAccountId("")
              }}
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
