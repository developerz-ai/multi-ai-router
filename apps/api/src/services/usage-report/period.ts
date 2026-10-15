/**
 * The weekly report's calendar, in UTC and nothing else.
 *
 * Pure: every function takes the instant it reasons about. The week is a UTC Monday-to-Monday
 * window because the rollup `day` is UTC (`usage-batch-mutation.ts` dates a row by
 * `createdAt.toISOString().slice(0, 10)`). `Date#getUTCDay()` counts Sunday as 0, so the Monday
 * arithmetic below goes through `(day + 6) % 7`; a plain `day - 1` would put Sunday a week ahead.
 */

export const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

/** One report week: Monday 00:00 UTC (inclusive) to the next Monday 00:00 UTC (exclusive). */
export interface ReportWeek {
  readonly start: Date
  readonly end: Date
}

/** `YYYY-MM-DD`, UTC. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** The latest Monday 00:00 UTC at or before `now`. */
export function latestMonday(now: Date): Date {
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS
  const sinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7
  return new Date(dayStart - sinceMonday * DAY_MS)
}

/**
 * The last complete UTC week as of `now`: the one that ended on the latest Monday. At Monday
 * 00:00:00.000 exactly that is the week that has just ended; at Sunday 23:59:59.999 it is still
 * the week that ended the Monday before.
 */
export function lastCompleteWeek(now: Date): ReportWeek {
  const end = latestMonday(now)
  return { start: new Date(end.getTime() - WEEK_MS), end }
}

/**
 * The instant a report becomes due: the latest Monday 00:00 UTC plus the configured offset
 * (`(weekday - 1)` days, hours and the settle margin). Boot refuses an offset of a week or more,
 * which would put this after the next Monday forever.
 */
export function reportAnchor(now: Date, offsetMs: number): Date {
  return new Date(latestMonday(now).getTime() + offsetMs)
}

const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/

/**
 * A `YYYY-MM-DD` path segment as a Monday 00:00 UTC, or `undefined` for anything else: a
 * malformed string, a date the calendar does not have (`2026-02-30`), or a day that is not a
 * Monday.
 */
export function parseReportWeek(value: string): Date | undefined {
  if (!DAY_FORMAT.test(value)) return undefined
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || isoDay(parsed) !== value) return undefined
  return parsed.getUTCDay() === 1 ? parsed : undefined
}
