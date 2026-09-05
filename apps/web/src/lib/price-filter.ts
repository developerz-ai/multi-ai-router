import type { PriceRow } from "./api/settings"

// Narrowing the price table. Pure: rows and the operator's query in, the visible rows out.
//
// The shipped table is a few hundred `(provider, model)` pairs and renders tens of thousands of
// pixels tall in full. Nobody reads it top to bottom — they come for one model — so the section
// opens folded to the first page with a search box, and "show all" is the deliberate act.

/** Rows shown while folded. Enough to see the shape of the table, not enough to scroll past. */
export const PRICE_PAGE_SIZE = 25

/** Substring match on model id or provider id, case-insensitive. Blank matches everything. */
export function filterPriceRows(rows: readonly PriceRow[], query: string): readonly PriceRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === "") return rows
  return rows.filter(
    (row) =>
      row.model.toLowerCase().includes(needle) || row.provider.toLowerCase().includes(needle),
  )
}

export interface VisiblePriceRows {
  readonly rows: readonly PriceRow[]
  /** How many the filter matched, before folding. */
  readonly matched: number
  /** How many the fold hid. Zero when nothing is folded. */
  readonly hidden: number
}

/**
 * What the table renders. A non-blank query unfolds its matches — the operator asked for them —
 * and an edited row is never folded away, because "where did my change go" is worse than a longer
 * table.
 */
export function visiblePriceRows(
  rows: readonly PriceRow[],
  query: string,
  showAll: boolean,
  isEdited: (row: PriceRow) => boolean,
  pageSize = PRICE_PAGE_SIZE,
): VisiblePriceRows {
  const matched = filterPriceRows(rows, query)
  if (showAll || query.trim() !== "" || matched.length <= pageSize) {
    return { rows: matched, matched: matched.length, hidden: 0 }
  }
  const visible = matched.filter((row, index) => index < pageSize || isEdited(row))
  return { rows: visible, matched: matched.length, hidden: matched.length - visible.length }
}
