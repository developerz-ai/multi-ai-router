import { describe, expect, test } from "bun:test"
import { type Baseline, compareToBaseline, renderDelta, toBaseline } from "../../../bench/baseline"
import type { Budgets, Row, Verdict } from "../../../bench/report"

/**
 * The delta-vs-baseline math is what CI's non-blocking bench job reports (docs/idea/08 -
 * "Verifying the budget", task: gate the budget as a report, not a build-failer). Pure: no file
 * I/O, no process, no clock — `run.ts` owns reading/writing `bench/baseline.json`.
 */

function row(overrides: Partial<Row> = {}): Row {
  return {
    scenario: "passthrough",
    path: "passthrough",
    samples: 1_000,
    failures: 0,
    overheadMeanMs: 1,
    overheadP50Ms: 1,
    overheadP95Ms: 2,
    overheadP99Ms: 3,
    overheadQuantized: false,
    addedTtftSamples: 0,
    addedTtftP50Ms: Number.NaN,
    addedTtftP95Ms: Number.NaN,
    addedTtftP99Ms: Number.NaN,
    buffered: 0,
    streamed: false,
    ...overrides,
  }
}

const BUDGETS: Budgets = { overheadP99Ms: 5, addedTtftP95Ms: 2 }

function verdictOf(rows: readonly Row[]): Verdict {
  return { rows, budgets: BUDGETS, violations: [] }
}

/** A streamed row, since only those carry the TTFT half of the budget. */
function streamRow(overrides: Partial<Row> = {}): Row {
  return row({
    scenario: "passthrough (stream)",
    streamed: true,
    addedTtftSamples: 1_000,
    addedTtftP50Ms: 0.1,
    addedTtftP95Ms: 0.4,
    addedTtftP99Ms: 0.9,
    ...overrides,
  })
}

describe("toBaseline", () => {
  test("carries the budget and the numbers a future run needs to compare against, nothing else", () => {
    const baseline = toBaseline(verdictOf([row()]))

    expect(baseline).toEqual({
      version: 2,
      budgets: BUDGETS,
      rows: [
        {
          scenario: "passthrough",
          path: "passthrough",
          overheadMeanMs: 1,
          overheadP50Ms: 1,
          overheadP95Ms: 2,
          overheadP99Ms: 3,
          addedTtftP50Ms: null,
          addedTtftP95Ms: null,
        },
      ],
    })
  })

  test("records the gated TTFT quantile, so a later run can see it drift", () => {
    const baseline = toBaseline(verdictOf([streamRow()]))

    expect(baseline.rows[0]?.addedTtftP95Ms).toBe(0.4)
  })
})

describe("compareToBaseline", () => {
  test("computes both the absolute and percent delta for mean and p99", () => {
    const baseline: Baseline = toBaseline(verdictOf([row({ overheadMeanMs: 1, overheadP99Ms: 3 })]))
    const current = verdictOf([row({ overheadMeanMs: 2, overheadP99Ms: 6 })])

    const [delta] = compareToBaseline(baseline, current)

    expect(delta).toMatchObject({
      isNew: false,
      deltaMeanMs: 1,
      deltaMeanPct: 100,
      deltaP99Ms: 3,
      deltaP99Pct: 100,
    })
  })

  test("flags a scenario absent from the baseline as new, not as an infinite regression", () => {
    const baseline: Baseline = { version: 2, budgets: BUDGETS, rows: [] }
    const current = verdictOf([row({ scenario: "translate" })])

    const [delta] = compareToBaseline(baseline, current)

    expect(delta?.isNew).toBe(true)
    expect(delta?.deltaMeanPct).toBeNaN()
    expect(Number.isNaN(delta?.baselineOverheadMeanMs)).toBe(true)
  })

  test("does not divide by zero when the baseline recorded no overhead", () => {
    const baseline: Baseline = toBaseline(verdictOf([row({ overheadMeanMs: 0, overheadP99Ms: 0 })]))
    const unchanged = verdictOf([row({ overheadMeanMs: 0, overheadP99Ms: 0 })])
    const grew = verdictOf([row({ overheadMeanMs: 1, overheadP99Ms: 1 })])

    expect(compareToBaseline(baseline, unchanged)[0]?.deltaMeanPct).toBe(0)
    expect(compareToBaseline(baseline, grew)[0]?.deltaMeanPct).toBeNaN()
  })

  test("tracks added-TTFT drift too — the budget's other half is not report-only", () => {
    const baseline: Baseline = toBaseline(verdictOf([streamRow({ addedTtftP95Ms: 0.4 })]))
    const current = verdictOf([streamRow({ addedTtftP95Ms: 0.6 })])

    const [delta] = compareToBaseline(baseline, current)

    expect(delta).toMatchObject({ streamed: true, baselineAddedTtftP95Ms: 0.4 })
    expect(delta?.deltaAddedTtftP95Ms).toBeCloseTo(0.2, 10)
    expect(delta?.deltaAddedTtftP95Pct).toBeCloseTo(50, 10)
  })

  test("leaves a non-streamed scenario's TTFT delta undefined rather than inventing a zero", () => {
    const baseline: Baseline = toBaseline(verdictOf([row()]))

    const [delta] = compareToBaseline(baseline, verdictOf([row()]))

    expect(delta?.streamed).toBe(false)
    expect(delta?.baselineAddedTtftP95Ms).toBeNaN()
    expect(delta?.deltaAddedTtftP95Ms).toBeNaN()
  })

  test("matches rows by scenario name, not by array position", () => {
    const baseline: Baseline = toBaseline(
      verdictOf([
        row({ scenario: "translate", overheadMeanMs: 9 }),
        row({ scenario: "passthrough", overheadMeanMs: 1 }),
      ]),
    )
    const current = verdictOf([
      row({ scenario: "passthrough", overheadMeanMs: 2 }),
      row({ scenario: "translate", overheadMeanMs: 9 }),
    ])

    const deltas = compareToBaseline(baseline, current)

    expect(deltas.find((entry) => entry.scenario === "passthrough")?.deltaMeanMs).toBe(1)
    expect(deltas.find((entry) => entry.scenario === "translate")?.deltaMeanMs).toBe(0)
  })
})

describe("renderDelta", () => {
  test("prints a table naming this as a report, never a gate", () => {
    const baseline: Baseline = toBaseline(verdictOf([row()]))
    const text = renderDelta(compareToBaseline(baseline, verdictOf([row({ overheadMeanMs: 4 })])))

    expect(text).toContain("never fails the build")
    expect(text).toContain("passthrough")
    expect(text).toContain("+300%")
  })

  test("prints both halves of the budget, so a TTFT regression is visible on the PR", () => {
    const baseline: Baseline = toBaseline(verdictOf([streamRow({ addedTtftP95Ms: 0.4 })]))
    const text = renderDelta(
      compareToBaseline(baseline, verdictOf([streamRow({ addedTtftP95Ms: 0.8 })])),
    )

    expect(text).toContain("router_overhead_seconds")
    expect(text).toContain("added time-to-first-token")
    expect(text).toContain("0.40 ms")
    expect(text).toContain("0.80 ms")
  })

  test("marks a new scenario instead of printing a bogus delta", () => {
    const text = renderDelta(
      compareToBaseline({ version: 2, budgets: BUDGETS, rows: [] }, verdictOf([row()])),
    )

    expect(text).toContain("passthrough (new)")
  })
})
