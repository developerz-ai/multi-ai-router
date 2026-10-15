import type { z } from "zod"
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
 * - a combined anchor offset of a full week or more: the anchor would always fall after the next
 *   Monday, so the task would tick every interval, succeed with nothing to do and keep the health
 *   screen green while no report was ever made.
 * - weekday and hour outside their ranges (the field parsers below).
 */
export const MIN_USAGE_REPORTS_RETENTION_DAYS = 14
const WEEK_MINUTES = 7 * 24 * 60

export const USAGE_REPORT_ENV_FIELDS = {
  USAGE_REPORT_INTERVAL_MINUTES: atLeastOne.optional(),
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
}

/** Minutes from the week's Monday 00:00 UTC to the instant the report becomes due. */
export function anchorOffsetMinutes(config: UsageReportConfig): number {
  return (config.weekday - 1) * 1_440 + config.hourUtc * 60 + config.settleMinutes
}

export function readUsageReportEnv(
  raw: {
    USAGE_REPORT_INTERVAL_MINUTES?: number
    USAGE_REPORT_WEEKDAY?: number
    USAGE_REPORT_HOUR_UTC?: number
    USAGE_REPORT_SETTLE_MINUTES?: number
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
  }
  const offset = anchorOffsetMinutes(usageReport)
  if (offset >= WEEK_MINUTES) {
    ctx.addIssue({
      code: "custom",
      path: ["USAGE_REPORT_SETTLE_MINUTES"],
      message:
        `USAGE_REPORT_WEEKDAY, USAGE_REPORT_HOUR_UTC and USAGE_REPORT_SETTLE_MINUTES add up to ` +
        `${offset} minutes after Monday 00:00 UTC, which must be less than ${WEEK_MINUTES} (one ` +
        `week): the report would always fall due after the next Monday and never be generated`,
    })
    return undefined
  }

  return {
    usageReport,
    usageReportsDays,
    // Hourly: the anchor is a weekly instant, so the cadence only bounds how late a due report
    // can start; a restart resumes from the persisted last run.
    usageReportIntervalMinutes: raw.USAGE_REPORT_INTERVAL_MINUTES ?? 60,
  }
}
