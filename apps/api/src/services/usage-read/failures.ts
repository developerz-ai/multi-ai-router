import { isSuccessOutcome } from "@multi-ai-router/core"
import type { UsageOutcomeCount } from "@multi-ai-router/db"

/**
 * The error rate, taken apart.
 *
 * "3% of attempts failed" is a number nobody can act on. The three failures a router of this shape
 * produces have three different remedies and three different HTTP statuses, and CLAUDE.md
 * non-negotiable 7 exists because collapsing them is the mistake: a spent window is `429` and comes
 * back on a clock, a drained balance is `402` and comes back when a human tops it up, and a key
 * whose scope intersected to nothing is `403` and comes back when the operator changes the scope.
 * An operator staring at one percentage cannot tell which of those they are looking at, and the
 * first two are separated by "wait" versus "go and pay".
 *
 * So this reports the split. The classification itself stays in core (`UsageOutcome`) and the
 * grouping into remedies stays in the console — this module only counts, and it counts honestly:
 *
 * - **Read from retained raw rows.** Historical additive counts survive retention, but no
 *   historical per-outcome distribution is inferred from them. These detail counts include
 *   preselection failures whose account/model attribution is absent.
 * - **`attempts` is the scan's own denominator, not the summary's.** Every share the console draws
 *   divides two numbers from this one scan, so the parts always add up to the whole shown beside
 *   them, whatever the rollup did with the same window.
 * - **`partial` says when the window reaches past the surviving raw rows.** Then these counts are a
 *   floor rather than a total, and the console says so instead of drawing a share of a number that
 *   is missing its older half.
 */

export interface UsageFailures {
  /**
   * Attempts this scan covered — the denominator for every count below.
   *
   * Deliberately not `totals.attempts`: that one includes retained historical facts, and dividing a raw numerator by a stitched denominator produces a share of nothing.
   */
  readonly attempts: number
  /** Non-success attempts among them. The sum of `byOutcome`, always. */
  readonly errors: number
  /**
   * True when the summary's stitched totals know about attempts raw rows no longer hold — a window
   * wide enough to reach past retention. The counts are then a floor, and only the console's
   * caption changes: a floor is still the answer to "which failure was it", just not to "how many".
   */
  readonly partial: boolean
  /** One entry per non-success outcome that actually occurred, biggest first. Zeroes are absent. */
  readonly byOutcome: readonly UsageOutcomeCount[]
}

export const EMPTY_FAILURES: UsageFailures = {
  attempts: 0,
  errors: 0,
  partial: false,
  byOutcome: [],
}

/**
 * Folds one raw per-outcome scan into the shape the console reads.
 *
 * Pure — counts and a comparison. `stitchedAttempts` is the summary's own total, passed in rather
 * than read again. `historyIncomplete` includes missing or unregistered historical contributions,
 * whose absence cannot be proved from equal retained and historical counts alone.
 *
 * Ordering is decided here rather than in SQL: it is at most one row per member of `UsageOutcome`,
 * and "biggest first, ties by name" is a rule worth asserting without a database. The name
 * tiebreak is not decoration — without it two outcomes with equal counts swap places between
 * refreshes, which reads as movement in a screen an operator is watching for movement.
 */
export function foldFailures(
  counts: readonly UsageOutcomeCount[],
  stitchedAttempts: number,
  historyIncomplete = false,
): UsageFailures {
  const attempts = counts.reduce((sum, row) => sum + row.attempts, 0)
  const failures = counts
    .filter((row) => !isSuccessOutcome(row.outcome) && row.attempts > 0)
    .sort((a, b) => b.attempts - a.attempts || a.outcome.localeCompare(b.outcome))

  return {
    attempts,
    errors: failures.reduce((sum, row) => sum + row.attempts, 0),
    partial: historyIncomplete || attempts < stitchedAttempts,
    byOutcome: failures,
  }
}
