// The layout rules themselves — one function per table, each handed a
// measurement and a Checker, each naming the issue it guards (#62/#94 for the
// cost-vs-credential geometry, the alpha rule for the pill's opaque background).
// Pure: no DOM, no Playwright, so a failing rule is unit-testable against a
// hand-built measurement.
import {
  type BadgeMeas,
  type Box,
  backgroundAlpha,
  type Checker,
  clearance,
  contained,
  gap,
  intersects,
  type PageMeas,
  type TableMeas,
} from "./geometry"

export interface PageReport {
  readonly tables: number
  readonly rows: number
  readonly costBlocks: number
  readonly badges: number
  /** Smallest distance a cost block stays inside its own cell, all sides, all rows. */
  readonly minCellClearance: number
  /** Smallest gap between cost text and a credential badge (accounts) or any
   * neighbouring cell's box (keys). Negative would mean overlap; that fails first. */
  readonly minGap: number
  /** Distinct badge background alphas seen — the report prints them so a future
   * translucent tone is visible before it fails. */
  readonly alphas: readonly number[]
}

/** A table whose selector scope matched nothing — the run's own guard, not the layout's. */
function requireTable(c: Checker, table: TableMeas, page: string, index: number): void {
  c.check(
    table.rows.length > 0,
    `${page}: table #${index + 1} has zero rows — selector scope empty`,
  )
}

function alphaRule(c: Checker, badges: readonly BadgeMeas[], page: string): void {
  for (const badge of badges) {
    const alpha = backgroundAlpha(badge.background)
    c.check(
      alpha === 1 && badge.opacity === "1",
      `${page}: badge "${badge.text}" background ${badge.background} has alpha ${alpha} and opacity ${badge.opacity}, expected 1 and 1 (Badge.module.scss pins it opaque for #62)`,
    )
  }
}

/** Accounts: cost block inside its cell; cost text clear of every credential badge. */
export function assertAccounts(c: Checker, meas: PageMeas): PageReport {
  const page = "accounts"
  c.check(meas.tables.length > 0, `${page}: no tables rendered — selector scope empty`)
  let costBlocks = 0
  let rows = 0
  let badges = 0
  let minCellClearance = Number.POSITIVE_INFINITY
  let minGap = Number.POSITIVE_INFINITY
  const alphas = new Set<number>()

  meas.tables.forEach((table, i) => {
    requireTable(c, table, page, i)
    c.check(
      table.headers.some((h) => h.startsWith("Usage ·")),
      `${page}: table #${i + 1} has no "Usage ·" column (headers: ${table.headers.join(", ")})`,
    )
    c.check(
      table.headers.includes("Credential / login"),
      `${page}: table #${i + 1} has no "Credential / login" column (headers: ${table.headers.join(", ")})`,
    )

    const rowBadges = table.rows.flatMap((row) => row.badges)
    c.check(
      rowBadges.length > 0,
      `${page}: table #${i + 1} matched zero credential badges — selector scope empty`,
    )
    badges += rowBadges.length
    for (const badge of rowBadges) alphas.add(backgroundAlpha(badge.background))
    alphaRule(c, table.badges, page)

    const blocks = table.rows.filter((row) => row.costBlock !== null)
    c.check(
      blocks.length > 0,
      `${page}: table #${i + 1} matched zero cost blocks — selector scope empty`,
    )
    const texts = table.rows.filter((row) => row.costText !== null)
    c.check(
      texts.length > 0,
      `${page}: table #${i + 1} matched zero cost-text spans — selector scope empty`,
    )
    // The fixture is fixed, so every row has traffic: fewer matches than rows
    // means a row silently fell back to "no traffic" or lost a selector.
    c.check(
      blocks.length === table.rows.length,
      `${page}: table #${i + 1} only ${blocks.length} of ${table.rows.length} rows have a cost block`,
    )
    c.check(
      texts.length === table.rows.length,
      `${page}: table #${i + 1} only ${texts.length} of ${table.rows.length} rows have a cost-text span`,
    )
    costBlocks += blocks.length
    rows += table.rows.length

    table.rows.forEach((row, r) => {
      const block = row.costBlock
      if (block !== null) {
        c.check(
          contained(block, row.costCell),
          `${page}: table #${i + 1} row ${r + 1} cost block ink escapes its cell by ${(-clearance(block, row.costCell)).toFixed(1)}px (box ${JSON.stringify(block)} vs cell ${JSON.stringify(row.costCell)})`,
        )
        minCellClearance = Math.min(minCellClearance, clearance(block, row.costCell))
      }
      const text = row.costText
      if (text !== null) {
        for (const badge of rowBadges) {
          c.check(
            !intersects(text, badge.box),
            `${page}: table #${i + 1} row ${r + 1} cost text intersects badge "${badge.text}" (gap ${gap(text, badge.box).toFixed(1)}px)`,
          )
          minGap = Math.min(minGap, gap(text, badge.box))
        }
      }
    })
  })

  // The fixture's STORED row is the one #62 painted through; losing it would
  // leave the gate green over a table that no longer holds the failing shape.
  // Page-wide: the page renders more than one table and only one holds it.
  c.check(
    meas.tables.some((t) =>
      t.rows.some((r) => r.badges.some((b) => b.text.toLowerCase() === "stored")),
    ),
    `${page}: no credential badge reading "stored" on the page — the fixture's STORED row is gone`,
  )

  return {
    tables: meas.tables.length,
    rows,
    costBlocks,
    badges,
    minCellClearance,
    minGap,
    alphas: [...alphas],
  }
}

/** Keys: SpendCell inside its own COST column, clear of every other cell's content. */
export function assertKeys(c: Checker, meas: PageMeas): PageReport {
  const page = "keys"
  c.check(meas.tables.length > 0, `${page}: no tables rendered — selector scope empty`)
  let costBlocks = 0
  let rows = 0
  let badges = 0
  let minCellClearance = Number.POSITIVE_INFINITY
  let minGap = Number.POSITIVE_INFINITY
  const alphas = new Set<number>()

  meas.tables.forEach((table, i) => {
    requireTable(c, table, page, i)
    c.check(
      table.headers.some((h) => h.startsWith("Cost ·")),
      `${page}: table #${i + 1} has no "Cost ·" column (headers: ${table.headers.join(", ")})`,
    )

    badges += table.badges.length
    for (const badge of table.badges) alphas.add(backgroundAlpha(badge.background))
    alphaRule(c, table.badges, page)
    c.check(
      table.badges.length > 0,
      `${page}: table #${i + 1} matched zero State badges — selector scope empty`,
    )

    const blocks = table.rows.filter((row) => row.costBlock !== null)
    c.check(
      blocks.length > 0,
      `${page}: table #${i + 1} matched zero SpendCell blocks — selector scope empty`,
    )
    c.check(
      blocks.length === table.rows.length,
      `${page}: table #${i + 1} only ${blocks.length} of ${table.rows.length} rows have a SpendCell`,
    )
    costBlocks += blocks.length
    rows += table.rows.length

    table.rows.forEach((row, r) => {
      const block = row.costBlock
      if (block === null) return
      c.check(
        contained(block, row.costCell),
        `${page}: table #${i + 1} row ${r + 1} SpendCell ink escapes its cell by ${(-clearance(block, row.costCell)).toFixed(1)}px`,
      )
      minCellClearance = Math.min(minCellClearance, clearance(block, row.costCell))
      c.check(
        row.others.length > 0,
        `${page}: table #${i + 1} row ${r + 1} matched zero neighbouring cells — selector scope empty`,
      )
      for (const other of row.others) {
        c.check(
          !intersects(block, other.ink),
          `${page}: table #${i + 1} row ${r + 1} SpendCell intersects a neighbouring cell's content (gap ${gap(block, other.ink).toFixed(1)}px)`,
        )
        // A neighbour whose content paints past its own cell is the collapse that
        // broke #62 even when it has not yet reached the SpendCell's ink.
        c.check(
          contained(other.ink, other.cell),
          `${page}: table #${i + 1} row ${r + 1} a neighbouring cell's content escapes its cell by ${(-clearance(other.ink, other.cell)).toFixed(1)}px`,
        )
        minGap = Math.min(minGap, gap(block, other.ink))
      }
    })
  })

  return {
    tables: meas.tables.length,
    rows,
    costBlocks,
    badges,
    minCellClearance,
    minGap,
    alphas: [...alphas],
  }
}

/** The numbers the PR body records, one line per page per width. */
export function reportLine(page: string, width: number, r: PageReport): string {
  return `[${page} @${width}px] tables=${r.tables} rows=${r.rows} costBlocks=${r.costBlocks} badges=${r.badges} minCellClearance=${fmt(r.minCellClearance)}px minGap=${fmt(r.minGap)}px badgeAlphas=[${r.alphas.join(",")}]`
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : "n/a"
}

export type { Box }
