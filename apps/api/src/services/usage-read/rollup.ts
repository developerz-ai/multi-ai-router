import type {
  UsageDailyGroupRow,
  UsageDayRange,
  UsageTotals,
  UsageWindow,
} from "@multi-ai-router/db"
import { startOfNextUtcDay, startOfUtcDay, toUtcDay } from "@multi-ai-router/db"

/**
 * How one window is answered from two tables.
 *
 * Pure: a window, a clock reading, and arithmetic. Which slice comes from where
 * is a decision worth testing without a database, and the summing is worth
 * testing without one twice over — the whole point of the rollup is that the
 * numbers survive the raw rows, so getting the addition wrong is a silent
 * error that nothing downstream can catch.
 *
 * **Whole closed days come from `usage_daily`; the edges come from raw rows.**
 * Raw `usage_records` expire on the retention window and the rollup does not,
 * so any total that reaches past the window — `lifetime`, most obviously — is
 * only correct if the closed days are read from the rollup
 * (docs/idea/08-observability.md, "Why it stays fast").
 *
 * The edges are the two slices the day grain cannot express: a window starting
 * mid-day (`7d` is *now minus seven days*, not seven calendar days) and today,
 * whose rolled row is at most as fresh as the last hourly tick. Both are read
 * from raw and added, which is exact because the three ranges are disjoint by
 * construction.
 *
 * **A day counts as closed only once a rollup that certainly covered it has
 * succeeded.** Without that condition the read would trust rows the writer has
 * not written yet — and since "no rolled row" and "no traffic" are the same
 * empty result, a router in the first hour after boot, or one whose rollup task
 * is wedged, would report the affected days as *zero* rather than as missing.
 * Deferring to raw rows until the rollup catches up costs a scan of days that
 * are still there anyway, and never silently loses a day.
 */

export interface WindowSplit {
  /** Whole UTC days entirely inside the window, in the past, and known rolled. Null when none. */
  readonly closedDays: UsageDayRange | null
  /**
   * Instant ranges raw rows must answer. Empty ranges are dropped, so this is
   * `[whole window]` when nothing is closed and never contains a zero-width slice.
   */
  readonly rawSlices: readonly UsageWindow[]
}

/**
 * Splits a window at UTC day boundaries.
 *
 * `now` bounds the closed range independently of `window.to`: today's rolled row
 * exists but trails the last tick, so today is always read raw even when the
 * window ends in the future.
 *
 * `lastRollupAt` is the *start* of the last successful rollup run, and `null`
 * when there has never been one. A run that started at `T` scans back to at
 * least the beginning of the previous day, so every day before `T`'s own day is
 * complete in the rollup and no later day is.
 */
export function splitWindow(
  window: UsageWindow,
  now: Date,
  lastRollupAt: Date | null,
): WindowSplit {
  if (lastRollupAt === null) return { closedDays: null, rawSlices: [window] }

  const closedStart = startOfNextUtcDay(window.from)
  const closedEnd = new Date(
    Math.min(
      startOfUtcDay(now).getTime(),
      startOfUtcDay(window.to).getTime(),
      startOfUtcDay(lastRollupAt).getTime(),
    ),
  )

  if (closedStart.getTime() >= closedEnd.getTime()) {
    return { closedDays: null, rawSlices: [window] }
  }

  return {
    closedDays: { fromDay: toUtcDay(closedStart), toDay: toUtcDay(closedEnd) },
    rawSlices: [
      { from: window.from, to: closedStart },
      { from: closedEnd, to: window.to },
    ].filter((slice) => slice.from.getTime() < slice.to.getTime()),
  }
}

export const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  attempts: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: "0",
  costNotional: "0",
}

/** Adds disjoint slices of one window. Counts add; the two spend columns stay apart, as always. */
export function sumTotals(parts: readonly UsageTotals[]): UsageTotals {
  return parts.reduce<UsageTotals>(
    (a, b) => ({
      requests: a.requests + b.requests,
      attempts: a.attempts + b.attempts,
      errors: a.errors + b.errors,
      tokensIn: a.tokensIn + b.tokensIn,
      tokensOut: a.tokensOut + b.tokensOut,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      costMetered: addDecimal(a.costMetered, b.costMetered),
      costNotional: addDecimal(a.costNotional, b.costNotional),
    }),
    EMPTY_TOTALS,
  )
}

/**
 * Merges per-dimension rows from every slice, biggest first.
 *
 * `requests` is the one measure that is **not** exactly additive here: it counts
 * distinct correlation ids, and a request whose attempts straddle midnight is
 * counted once on each side. That costs at most one request per chain per
 * boundary and is the price of a day grain; the alternative is keeping raw rows
 * forever, which is the thing the rollup exists to avoid.
 */
export function mergeGroupRows(
  slices: readonly (readonly UsageDailyGroupRow[])[],
): UsageDailyGroupRow[] {
  const byId = new Map<string | null, UsageTotals>()

  for (const slice of slices) {
    for (const row of slice) {
      const { id, ...totals } = row
      byId.set(id, sumTotals([byId.get(id) ?? EMPTY_TOTALS, totals]))
    }
  }

  return [...byId]
    .map(([id, totals]) => ({ id, ...totals }))
    .sort((a, b) => b.attempts - a.attempts)
}

/**
 * Exact addition of two decimal strings.
 *
 * Spend crosses the repository boundary as text precisely so a `numeric(14, 6)`
 * never becomes a float, and adding two slices in JS numbers here would undo
 * that at the last step. Scaling both to the wider of the two fractions and
 * adding as `BigInt` keeps every digit; the sign rides on the integer part, so
 * `"-0.5"` scales to `-5` without a special case.
 */
export function addDecimal(a: string, b: string): string {
  const [aInt, aFrac] = splitDecimal(a)
  const [bInt, bFrac] = splitDecimal(b)
  const scale = Math.max(aFrac.length, bFrac.length)

  const sum = BigInt(aInt + aFrac.padEnd(scale, "0")) + BigInt(bInt + bFrac.padEnd(scale, "0"))
  if (scale === 0) return sum.toString()

  const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, "0")
  const sign = sum < 0n ? "-" : ""
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function splitDecimal(value: string): [string, string] {
  const point = value.indexOf(".")
  return point === -1 ? [value, ""] : [value.slice(0, point), value.slice(point + 1)]
}
