// The fixture's stress inputs must actually RENDER. A geometry gate that
// measures a cell reading "$0.00" proves nothing about a five-digit spend, and
// an id rename in the fixture's usage join degrades to exactly that silently.
// Pure like rules.ts: handed a measurement, a Checker and the expectations.
import type { Checker, PageMeas } from "./geometry"

export interface StressExpectation {
  /** Rows the fixture defines for this surface, summed across the page's tables. */
  readonly rows: number
  /** Substrings that must each appear in some row's cost-block text. */
  readonly figures: readonly { readonly label: string; readonly text: string }[]
  /** Substring that must NOT be the only content of the STORED row's figures. */
  readonly storedRowNotZero: boolean
}

const ZERO = "$0.00"

export function assertStress(
  c: Checker,
  page: string,
  meas: PageMeas,
  expected: StressExpectation,
): void {
  const rows = meas.tables.flatMap((t) => t.rows)
  c.check(
    rows.length === expected.rows,
    `${page}: rendered ${rows.length} rows, fixture defines ${expected.rows}`,
  )
  for (const figure of expected.figures) {
    c.check(
      rows.some((r) => r.costBlockText?.includes(figure.text) === true),
      `${page}: stress cell "${figure.label}" never rendered ${figure.text} — the fixture's usage join no longer reaches it (id renamed on one side?)`,
    )
  }
  if (expected.storedRowNotZero) {
    const stored = rows.filter((r) => r.badges.some((b) => b.text.toLowerCase() === "stored"))
    c.check(stored.length > 0, `${page}: no STORED row to hold the metered+notional stress on`)
    for (const row of stored) {
      const text = row.costBlockText ?? ""
      const amounts = text.match(/\$[\d,]+(?:\.\d+)?/g) ?? []
      c.check(
        amounts.length >= 2 && amounts.every((a) => a !== ZERO),
        `${page}: STORED row cost block "${text}" does not show two non-${ZERO} figures (metered and notional)`,
      )
    }
  }
}
