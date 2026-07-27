import { describe, expect, test } from "bun:test"
import { UsageOutcome } from "@multi-ai-router/core"
import type { UsageOutcomeCount } from "@multi-ai-router/db"
import { EMPTY_FAILURES, foldFailures } from "../../../src/services/usage-read"

/**
 * The error rate, taken apart.
 *
 * The property this file exists for is CLAUDE.md non-negotiable 7 rendered as an
 * aggregate: `quota_exhausted` and `credits_exhausted` must arrive as two
 * numbers, because one is a window a clock refills and the other is a balance a
 * human refills. A fold that summed them into "capacity" would put "wait" and
 * "go and pay" behind one figure, which is the mistake the whole status
 * vocabulary exists to prevent.
 *
 * The rest is arithmetic that has to be right for the panel to add up: the
 * denominator is this scan's own, the order never wobbles between refreshes, and
 * `partial` is honest about a window that reaches past the rows it counted.
 */

function count(outcome: UsageOutcome, attempts: number): UsageOutcomeCount {
  return { outcome, attempts }
}

describe("foldFailures", () => {
  test("keeps rate limited and out of credits apart, never as one capacity figure", () => {
    const folded = foldFailures(
      [count("success", 90), count("quota_exhausted", 7), count("credits_exhausted", 3)],
      100,
    )

    expect(folded.byOutcome).toEqual([
      { outcome: "quota_exhausted", attempts: 7 },
      { outcome: "credits_exhausted", attempts: 3 },
    ])
    // The forbidden number: 10 is the two added together, which is what a
    // "capacity" bucket would report and what nobody can act on.
    expect(folded.byOutcome.some((row) => row.attempts === 10)).toBe(false)
  })

  test("drops success from the split while still counting it in the denominator", () => {
    const folded = foldFailures([count("success", 97), count("scope_violation", 3)], 100)

    expect(folded.attempts).toBe(100)
    expect(folded.errors).toBe(3)
    expect(folded.byOutcome.map((row) => row.outcome)).not.toContain("success")
  })

  test("counts the denominator from its own scan, not from the stitched total", () => {
    // The rollup knows about 900 attempts the raw rows no longer hold.
    const folded = foldFailures([count("success", 80), count("upstream_timeout", 20)], 1000)

    expect(folded.attempts).toBe(100)
    expect(folded.errors).toBe(20)
  })

  test("says the counts are a floor when the window outruns the rows behind them", () => {
    expect(foldFailures([count("success", 100)], 1000).partial).toBe(true)
  })

  test("is not partial when the scan saw every attempt the summary counted", () => {
    expect(foldFailures([count("success", 90), count("router_error", 10)], 100).partial).toBe(false)
  })

  test("is not partial when the scan saw more than the rollup did", () => {
    // Today's rows are raw and unrolled, so the scan can legitimately lead.
    expect(foldFailures([count("success", 40)], 10).partial).toBe(false)
  })

  test("errors is exactly the sum of the split, so the parts add up to the whole", () => {
    const folded = foldFailures(
      [
        count("success", 500),
        count("quota_exhausted", 11),
        count("upstream_error", 4),
        count("client_error", 2),
      ],
      517,
    )

    expect(folded.errors).toBe(17)
    expect(folded.byOutcome.reduce((sum, row) => sum + row.attempts, 0)).toBe(folded.errors)
  })

  test("orders biggest first so the failure worth reading is at the top", () => {
    const folded = foldFailures(
      [count("client_error", 2), count("quota_exhausted", 30), count("upstream_error", 9)],
      41,
    )

    expect(folded.byOutcome.map((row) => row.outcome)).toEqual([
      "quota_exhausted",
      "upstream_error",
      "client_error",
    ])
  })

  test("breaks ties on the name, so two equal counts never swap between refreshes", () => {
    const rows = [
      count("upstream_error", 5),
      count("credits_exhausted", 5),
      count("router_error", 5),
    ]

    const forwards = foldFailures(rows, 15).byOutcome.map((row) => row.outcome)
    const backwards = foldFailures([...rows].reverse(), 15).byOutcome.map((row) => row.outcome)

    expect(forwards).toEqual(["credits_exhausted", "router_error", "upstream_error"])
    expect(backwards).toEqual(forwards)
  })

  test("omits an outcome that did not happen rather than reporting it as zero", () => {
    const folded = foldFailures([count("success", 10), count("key_revoked", 0)], 10)

    expect(folded.byOutcome).toEqual([])
    expect(folded.errors).toBe(0)
  })

  test("a window with no rows at all folds to the empty split, not to a throw", () => {
    expect(foldFailures([], 0)).toEqual(EMPTY_FAILURES)
  })

  test("every failure outcome core defines survives the fold", () => {
    // The gate against a fold that silently dropped the newest kind of failure —
    // an outcome added to core arrives here without anyone remembering to look.
    const failures = UsageOutcome.options.filter((outcome) => outcome !== "success")
    const folded = foldFailures(
      failures.map((outcome) => count(outcome, 1)),
      failures.length,
    )

    expect(folded.byOutcome).toHaveLength(failures.length)
    expect(folded.errors).toBe(failures.length)
    expect(new Set(folded.byOutcome.map((row) => row.outcome))).toEqual(new Set(failures))
  })
})
