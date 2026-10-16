import type { z } from "zod"
import { DEFAULT_SCHEDULER_JITTER_FRACTION } from "./env-defaults"
import { atLeastOne, wholeNumber } from "./fields"

/**
 * The weekly usage report's schedule and retention, as configuration (CLAUDE.md non-negotiable 11).
 *
 * The report covers the last complete UTC Monday-to-Monday week. It is generated once the
 * **anchor** has passed: the latest Monday 00:00 UTC plus `(weekday - 1)` days, `hourUtc` hours and
 * `settleMinutes`. The settle margin exists because usage rows are dated by attempt start and
 * written off-path, so an attempt still streaming at Monday 00:00 lands minutes later; the stored
 * report is never regenerated.
 *
 * Three refusals, all by name at boot rather than clamped:
 *
 * - `RETENTION_USAGE_REPORTS_DAYS` below {@link MIN_USAGE_REPORTS_RETENTION_DAYS}: the task
 *   regenerates a missing last-complete week, so a row swept while its week is still the target
 *   would be generated (and, once delivery lands, sent) again. Just before Monday 00:00 UTC the
 *   target week's row is almost exactly 14 days old, so 14 has no slack at all.
 * - a firing window (the time from the anchor to the end of the week) not longer than one slowest
 *   jittered tick plus {@link TICK_WORK_MINUTES}: the task would succeed with nothing to do and keep
 *   the health screen green while a tick stepped over the window and no report was made. An offset
 *   of a full week or more is the limit case, a window of zero. The issue names the schedule when
 *   the schedule closed the window and `USAGE_REPORT_INTERVAL_MINUTES` when the configured interval
 *   or jitter did — the setting that would actually have to move.
 * - weekday and hour outside their ranges (the field parsers below).
 */
export const MIN_USAGE_REPORTS_RETENTION_DAYS = 14
const WEEK_MINUTES = 7 * 24 * 60
/** Minutes kept clear of the end of the week for a tick's own work: one week read and an insert. */
export const TICK_WORK_MINUTES = 5
const DAY_MINUTES = 24 * 60
/**
 * The most `USAGE_REPORT_MAX_ROWS` accepts. The rows are held in memory while the report is built,
 * so past this the cap itself needs a code change — the too-large failure says so rather than
 * suggesting a raise that boot would refuse.
 */
export const USAGE_REPORT_MAX_ROWS_CEILING = 100_000
/** The check cadence when `USAGE_REPORT_INTERVAL_MINUTES` is unset. */
export const DEFAULT_USAGE_REPORT_INTERVAL_MINUTES = 60

export const USAGE_REPORT_ENV_FIELDS = {
  /** At most a day: a longer cadence is a report that can miss its window by design. */
  USAGE_REPORT_INTERVAL_MINUTES: atLeastOne
    .refine((value) => value <= DAY_MINUTES, "must be at most 1440 (one day)")
    .optional(),
  /** Rows the week read may return; over it the task fails and the preview answers 400. */
  USAGE_REPORT_MAX_ROWS: atLeastOne
    .refine(
      (value) => value <= USAGE_REPORT_MAX_ROWS_CEILING,
      `must be at most ${USAGE_REPORT_MAX_ROWS_CEILING}`,
    )
    .optional(),
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  USAGE_REPORT_WEEKDAY: atLeastOne
    .refine((value) => value <= 7, "must be between 1 (Monday) and 7 (Sunday)")
    .optional(),
  /** Zero is midnight, a real setting: see `ZERO_IS_LEGAL`. */
  USAGE_REPORT_HOUR_UTC: wholeNumber
    .refine((value) => value <= 23, "must be between 0 and 23")
    .optional(),
  USAGE_REPORT_SETTLE_MINUTES: atLeastOne.optional(),
  RETENTION_USAGE_REPORTS_DAYS: atLeastOne.optional(),
}

export interface UsageReportConfig {
  /** ISO weekday the report is generated on: 1 = Monday ... 7 = Sunday. */
  readonly weekday: number
  /** Hour of that day, UTC, 0-23. */
  readonly hourUtc: number
  /** Margin after that instant for attempts still being written. */
  readonly settleMinutes: number
  /** The week read's row ceiling (`USAGE_REPORT_MAX_ROWS`). */
  readonly maxRows: number
}

/**
 * Minutes from the week's Monday 00:00 UTC to the instant the report becomes due. Takes only the
 * schedule fields: the anchor is a property of the schedule, and `maxRows` is no part of it.
 */
export function anchorOffsetMinutes(
  config: Pick<UsageReportConfig, "weekday" | "hourUtc" | "settleMinutes">,
): number {
  return (config.weekday - 1) * 1_440 + config.hourUtc * 60 + config.settleMinutes
}

/**
 * The slowest tick as the firing-window refusal displays it. The comparison is exact; the display
 * rounds, and the rounding must never land on the window itself: "leaving 13 minutes … = 13"
 * reads as a window refused for being equal to itself, hiding the fraction (13.4) that actually
 * closed it. One decimal keeps the fraction visible; when the tenth also collapses onto the
 * window (13.04), round up instead — the displayed tick must be one the window visibly fails to
 * exceed. A tick exactly equal to the window keeps its decimal ("13.0"): that refusal *is* the
 * equality, and the decimal says the display is the real value rather than a rounding.
 */
export function displayedSlowestTick(slowestTick: number, windowMinutes: number): string {
  const nearest = Math.round(slowestTick)
  if (nearest !== windowMinutes) return String(nearest)
  const tenth = slowestTick.toFixed(1)
  if (Number(tenth) !== windowMinutes) return tenth
  const roundedUp = Math.ceil(slowestTick)
  return roundedUp === windowMinutes ? tenth : String(roundedUp)
}

export function readUsageReportEnv(
  raw: {
    USAGE_REPORT_INTERVAL_MINUTES?: number
    USAGE_REPORT_WEEKDAY?: number
    USAGE_REPORT_HOUR_UTC?: number
    USAGE_REPORT_SETTLE_MINUTES?: number
    USAGE_REPORT_MAX_ROWS?: number
    SCHEDULER_JITTER_FRACTION?: number
    RETENTION_USAGE_REPORTS_DAYS?: number
  },
  ctx: z.RefinementCtx,
):
  | {
      readonly usageReport: UsageReportConfig
      readonly usageReportsDays: number
      readonly usageReportIntervalMinutes: number
    }
  | undefined {
  // Two years, like the daily aggregates the reports are built from.
  const usageReportsDays = raw.RETENTION_USAGE_REPORTS_DAYS ?? 730
  if (usageReportsDays < MIN_USAGE_REPORTS_RETENTION_DAYS) {
    ctx.addIssue({
      code: "custom",
      path: ["RETENTION_USAGE_REPORTS_DAYS"],
      message:
        `must be at least ${MIN_USAGE_REPORTS_RETENTION_DAYS}: the weekly report task regenerates a ` +
        `missing last-complete week, and a stored row swept while its week is still the target ` +
        `would be generated again`,
    })
    return undefined
  }

  const usageReport: UsageReportConfig = {
    weekday: raw.USAGE_REPORT_WEEKDAY ?? 1,
    hourUtc: raw.USAGE_REPORT_HOUR_UTC ?? 0,
    settleMinutes: raw.USAGE_REPORT_SETTLE_MINUTES ?? 30,
    // The CSV export's ceiling: the same rows are held in memory while the report is built.
    maxRows: raw.USAGE_REPORT_MAX_ROWS ?? 50_000,
  }
  // The report is only made if a tick lands between the anchor and the end of the week. A tick can
  // be as late as interval * (1 + jitter) after the previous one, so the window must be longer
  // than that plus a margin for the tick's own work. Refused, not clamped: a schedule that can
  // step over its window looks configured and silently skips weeks. This also covers an offset of
  // a full week or more, where the window is zero or negative.
  const intervalMinutes = raw.USAGE_REPORT_INTERVAL_MINUTES ?? DEFAULT_USAGE_REPORT_INTERVAL_MINUTES
  const jitter = raw.SCHEDULER_JITTER_FRACTION ?? DEFAULT_SCHEDULER_JITTER_FRACTION
  const offset = anchorOffsetMinutes(usageReport)
  const window = WEEK_MINUTES - offset
  const slowestTick = intervalMinutes * (1 + jitter) + TICK_WORK_MINUTES
  if (slowestTick >= window) {
    // Blame the setting that would have to move. When even the default cadence and jitter cannot
    // fit the window, the schedule left too little of the week; a window the defaults fit was
    // closed by the configured interval or jitter, so the issue points at the interval.
    const defaultSlowestTick =
      DEFAULT_USAGE_REPORT_INTERVAL_MINUTES * (1 + DEFAULT_SCHEDULER_JITTER_FRACTION) +
      TICK_WORK_MINUTES
    ctx.addIssue({
      code: "custom",
      path: [
        defaultSlowestTick >= window
          ? "USAGE_REPORT_SETTLE_MINUTES"
          : "USAGE_REPORT_INTERVAL_MINUTES",
      ],
      // The comparison above stays exact; only the display rounds, and it never rounds onto the
      // window itself — see displayedSlowestTick.
      message:
        `USAGE_REPORT_WEEKDAY, USAGE_REPORT_HOUR_UTC and USAGE_REPORT_SETTLE_MINUTES add up to ` +
        `${offset} minutes after Monday 00:00 UTC, leaving ${window} minutes of the week to fire in, ` +
        `which must exceed one slowest tick (USAGE_REPORT_INTERVAL_MINUTES ${intervalMinutes} x ` +
        `(1 + SCHEDULER_JITTER_FRACTION ${jitter}) + ${TICK_WORK_MINUTES} minutes of work = ` +
        `${displayedSlowestTick(slowestTick, window)}): a tick could step over the whole window and the week would never be reported`,
    })
    return undefined
  }

  return {
    usageReport,
    usageReportsDays,
    // Hourly: the anchor is a weekly instant, so the cadence only bounds how late a due report
    // can start; a restart resumes from the persisted last run.
    usageReportIntervalMinutes: intervalMinutes,
  }
}
