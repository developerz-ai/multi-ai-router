import { type Accessor, createMemo, createSignal } from "solid-js"
import {
  buildPriceOverridePayload,
  diffOverrides,
  mergePriceRows,
  type PriceRow,
  type PriceTable,
  priceRowId,
  type RateField,
  withRates,
} from "../../lib/api/settings"
import type { ProviderDescriptor } from "../../lib/api/types"
import { visiblePriceRows } from "../../lib/price-filter"
import {
  draftOf,
  EMPTY_DRAFT,
  parseDraft,
  type RateDraft,
  toRate,
  ZERO_RATES,
} from "./price-editing"

const NO_PRICES: Pick<PriceTable, "shipped" | "overrides"> = { shipped: [], overrides: [] }

/**
 * The unsaved edits over the stored price table. Every list here is a memo: the screen reads each
 * several times per keystroke, and the merge sorts the whole table.
 */
export function createPriceState(prices: Accessor<PriceTable | undefined>) {
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, RateDraft>>>({})
  const [extras, setExtras] = createSignal<readonly PriceRow[]>([])
  const [dropped, setDropped] = createSignal<ReadonlySet<string>>(new Set())
  const [query, setQuery] = createSignal("")
  const [showAll, setShowAll] = createSignal(false)

  const table = () => prices() ?? NO_PRICES
  const merged = createMemo(() => mergePriceRows(table().shipped, table().overrides))

  // An extra whose row is stored is held back, not dropped: should someone else delete the stored
  // one, this session's unsaved rates still have a row.
  const added = createMemo(() => {
    const stored = new Set(merged().map((row) => row.id))
    return extras().filter((row) => !stored.has(row.id))
  })

  // A row added in this session sits at the end until the save lands and the
  // server's ordering takes over — a just-added row must not be hard to find.
  const rows = createMemo(() =>
    [...merged(), ...added()]
      .filter((row) => !dropped().has(row.id))
      .map((row) => withRates(row, parsed(row.id) ?? row.rates)),
  )
  const payload = createMemo(() => buildPriceOverridePayload(rows()))
  const diff = createMemo(() => diffOverrides(table().overrides, payload()))
  const unparseable = createMemo(() =>
    rows().filter((row) => drafts()[row.id] !== undefined && parsed(row.id) === null),
  )
  // Folded to the first page unless searched or unfolded; an edited row is never folded away.
  const visible = createMemo(() =>
    visiblePriceRows(rows(), query(), showAll(), (row) => drafts()[row.id] !== undefined),
  )

  function parsed(id: string) {
    const draft = drafts()[id]
    return draft === undefined ? null : parseDraft(draft)
  }

  return {
    rows,
    payload,
    diff,
    unparseable,
    visible,
    query,
    setQuery,
    showAll,
    setShowAll,
    /** Something a save would write. */
    dirty: () => diff().removed.length > 0 || diff().changed.length > 0,
    /** Something a discard would undo, including an edit that does not parse and so writes nothing. */
    touched: () => Object.keys(drafts()).length > 0 || extras().length > 0 || dropped().size > 0,
    cellValue: (row: PriceRow, field: RateField): string =>
      drafts()[row.id]?.[field] ?? String(row.rates[field]),
    badCell: (row: PriceRow, field: RateField): boolean => {
      const draft = drafts()[row.id]
      return draft !== undefined && toRate(draft[field]) === null
    },
    edit: (row: PriceRow, field: RateField, value: string) =>
      setDrafts((current) => ({
        ...current,
        [row.id]: { ...(current[row.id] ?? draftOf(row.rates)), [field]: value },
      })),
    revert: (row: PriceRow) => {
      const shipped = row.shipped
      if (shipped === null || row.preserveOverride) {
        // Remove extensions and explicit overrides whose shipped rate is attribution-only.
        setExtras((current) => current.filter((extra) => extra.id !== row.id))
        setDropped((current) => new Set(current).add(row.id))
        return
      }
      setDrafts((current) => ({ ...current, [row.id]: draftOf(shipped) }))
    },
    /** Adds an empty row, or answers why not. `model` is stored as the API indexes it. */
    add: (provider: ProviderDescriptor, model: string, accountId: string): string | null => {
      // Normalised here because `price_overrides` indexes a trimmed, lowercased
      // model name — two casings of one model must not become two rows.
      const name = model.trim().toLowerCase()
      const id = priceRowId(provider.id, name, accountId || null)
      if (rows().some((row) => row.id === id)) {
        return `${provider.id} / ${name} is already listed — edit its row instead.`
      }
      setExtras((current) => [
        ...current.filter((extra) => extra.id !== id),
        {
          id,
          accountId: accountId || null,
          provider: provider.id,
          model: name,
          origin: "added",
          shipped: null,
          rates: ZERO_RATES,
          longContext: null,
          updatedAt: null,
        },
      ])
      setDrafts((current) => ({ ...current, [id]: EMPTY_DRAFT }))
      setDropped((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      return null
    },
    discard: () => {
      setDrafts({})
      setExtras([])
      setDropped(new Set<string>())
    },
  }
}
