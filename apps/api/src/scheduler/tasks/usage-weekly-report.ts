import { describeError } from "@multi-ai-router/core"
import {
  isoDay,
  lastCompleteWeek,
  type ReportWeek,
  reportAnchor,
} from "../../services/usage-report"
import type { ScheduledTask, TaskOutcome } from "../types"

/**
 * The weekly usage report: generated once per UTC Monday-to-Monday week and stored, never
 * regenerated (issue #227).
 *
 * A tick runs when the **anchor** has passed — the latest Monday 00:00 UTC plus the configured
 * offset (weekday, hour, and the settle margin that lets attempts still being written land) — and
 * the last complete week has no stored row. Then it generates that one week. Three missed weeks
 * produce one late report, for the latest week, not three.
 *
 * Idempotent three ways: the tick checks `exists` first, the repository insert is
 * `ON CONFLICT (period_start) DO NOTHING` (so two generations that bypass the advisory lock still
 * leave one row), and a replica that loses the lock never reaches this function at all. The
 * interval is only how late a due report can start; a restart resumes from what is stored, not
 * from a timer.
 *
 * A tick before the anchor, or after the week already has its row, succeeds with zero items — the
 * normal state of this task for six days and twenty-odd hours in seven.
 */

export interface UsageWeeklyReportDeps {
  readonly reports: {
    exists(periodStart: string): Promise<boolean>
    /** `true` when this call wrote the row; `false` when the week already had one. */
    generate(week: ReportWeek, now: Date): Promise<boolean>
  }
  /** Minutes from Monday 00:00 UTC to the instant a report is due, in milliseconds. */
  readonly anchorOffsetMs: number
  readonly intervalMs: number
}

export function createUsageWeeklyReportTask(deps: UsageWeeklyReportDeps): ScheduledTask {
  return {
    name: "usage_weekly_report",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger }): Promise<TaskOutcome> => {
      try {
        if (now.getTime() < reportAnchor(now, deps.anchorOffsetMs).getTime())
          return { outcome: "success", itemsProcessed: 0 }
        const week = lastCompleteWeek(now)
        const periodStart = isoDay(week.start)
        if (await deps.reports.exists(periodStart)) return { outcome: "success", itemsProcessed: 0 }

        const wrote = await deps.reports.generate(week, now)
        logger.info("weekly usage report", {
          periodStart,
          periodEnd: isoDay(week.end),
          stored: wrote,
        })
        return { outcome: "success", itemsProcessed: wrote ? 1 : 0 }
      } catch (error) {
        const reason = describeError(error, Number.POSITIVE_INFINITY)
        logger.error("weekly usage report failed", { error: reason })
        return { outcome: "failed", itemsProcessed: 0, error: reason }
      }
    },
  }
}
