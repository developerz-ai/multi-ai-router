import type { Row, Verdict } from "./report"

/**
 * Comparing a bench run to the numbers committed in `bench/baseline.json`.
 *
 * `bin/bench`'s own pass/fail (`Verdict.violations`) is an absolute budget check, and CI runs it
 * `continue-on-error` on purpose — a shared runner's jitter is not a signal worth blocking a merge
 * over (docs/idea/08-observability.md, "Verifying the budget"). What CI needs *in addition* is a
 * relative view: is this PR's overhead drifting away from the last numbers a human committed, in
 * either direction? That is this file's only job. Pure: baseline and verdict in, delta rows out —
 * no file I/O, no process exit, so it is unit-testable without booting anything.
 */

export interface BaselineRow {
  readonly scenario: string
  readonly path: string
  readonly overheadMeanMs: number
  readonly overheadP50Ms: number
  readonly overheadP95Ms: number
  readonly overheadP99Ms: number
  /** `null`, not `NaN` — `JSON.stringify` turns `NaN` into `null`, and the baseline is JSON on disk. */
  readonly addedTtftP50Ms: number | null
}

export interface Baseline {
  /** Schema guard: a baseline written by a future, incompatible format should not silently diff. */
  readonly version: 1
  readonly budgetMs: number
  readonly rows: readonly BaselineRow[]
}

export interface DeltaRow {
  readonly scenario: string
  readonly path: string
  readonly baselineOverheadMeanMs: number
  readonly currentOverheadMeanMs: number
  readonly deltaMeanMs: number
  /** Percent change vs baseline. `NaN` when the baseline mean was 0 (division has no meaning). */
  readonly deltaMeanPct: number
  readonly baselineOverheadP99Ms: number
  readonly currentOverheadP99Ms: number
  readonly deltaP99Ms: number
  readonly deltaP99Pct: number
  /** True when this scenario has no baseline row yet — a new scenario, not a regression. */
  readonly isNew: boolean
}

/** What a bench run commits as tomorrow's baseline — the report's own numbers, nothing derived. */
export function toBaseline(verdict: Verdict): Baseline {
  return {
    version: 1,
    budgetMs: verdict.budgetMs,
    rows: verdict.rows.map((row) => ({
      scenario: row.scenario,
      path: row.path,
      overheadMeanMs: row.overheadMeanMs,
      overheadP50Ms: row.overheadP50Ms,
      overheadP95Ms: row.overheadP95Ms,
      overheadP99Ms: row.overheadP99Ms,
      addedTtftP50Ms: Number.isNaN(row.addedTtftP50Ms) ? null : row.addedTtftP50Ms,
    })),
  }
}

function pct(delta: number, base: number): number {
  if (base === 0) return delta === 0 ? 0 : Number.NaN
  return (delta / base) * 100
}

/** Matched by scenario name — the same identity `report.ts` groups rows by. */
export function compareToBaseline(baseline: Baseline, verdict: Verdict): readonly DeltaRow[] {
  const byScenario = new Map(baseline.rows.map((row) => [row.scenario, row]))

  return verdict.rows.map((current) => {
    const base = byScenario.get(current.scenario)
    const baselineMean = base?.overheadMeanMs ?? Number.NaN
    const baselineP99 = base?.overheadP99Ms ?? Number.NaN
    const deltaMeanMs = current.overheadMeanMs - baselineMean
    const deltaP99Ms = current.overheadP99Ms - baselineP99

    return {
      scenario: current.scenario,
      path: current.path,
      baselineOverheadMeanMs: baselineMean,
      currentOverheadMeanMs: current.overheadMeanMs,
      deltaMeanMs,
      deltaMeanPct: base === undefined ? Number.NaN : pct(deltaMeanMs, baselineMean),
      baselineOverheadP99Ms: baselineP99,
      currentOverheadP99Ms: current.overheadP99Ms,
      deltaP99Ms,
      deltaP99Pct: base === undefined ? Number.NaN : pct(deltaP99Ms, baselineP99),
      isNew: base === undefined,
    }
  })
}

function ms(value: number): string {
  return Number.isNaN(value) ? "—" : `${value.toFixed(2)} ms`
}

function pctString(value: number): string {
  if (Number.isNaN(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(0)}%`
}

const HEADERS = [
  "scenario",
  "baseline mean",
  "current mean",
  "Δ mean",
  "baseline p99",
  "current p99",
  "Δ p99",
]

export function renderDelta(rows: readonly DeltaRow[]): string {
  const table = rows.map((row) => [
    row.isNew ? `${row.scenario} (new)` : row.scenario,
    ms(row.baselineOverheadMeanMs),
    ms(row.currentOverheadMeanMs),
    row.isNew ? "—" : `${ms(row.deltaMeanMs)} (${pctString(row.deltaMeanPct)})`,
    ms(row.baselineOverheadP99Ms),
    ms(row.currentOverheadP99Ms),
    row.isNew ? "—" : `${ms(row.deltaP99Ms)} (${pctString(row.deltaP99Pct)})`,
  ])

  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...table.map((entry) => (entry[column] ?? "").length)),
  )
  const line = (cells: readonly string[]) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}`.trimEnd()

  return [
    "router_overhead_seconds — this run vs bench/baseline.json (report only, never fails the build)",
    "",
    line(HEADERS),
    `  ${widths.map((width) => "-".repeat(width)).join("  ")}`,
    ...table.map(line),
  ].join("\n")
}

// Re-exported so callers that only need the shape don't also import `report.ts`.
export type { Row }
