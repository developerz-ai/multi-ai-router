import { describeError } from "@multi-ai-router/core"
import {
  type DueDelivery,
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
 *
 * **Delivery (issue #229)** rides every post-anchor tick, not just the generating one: after the
 * row exists, the tick hands the period to the delivery service, which posts a `pending` latest
 * row to the Discord webhook or explains why it did not. Retries are therefore "the next tick",
 * and a give-up fails this task's outcome with the scrubbed reason. Absent `delivery` dep — the
 * pre-#229 shape — generation behaves exactly as before.
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
  /**
   * The Discord delivery service's due-posting half (issue #229). Called on every post-anchor
   * tick with the latest period; it owns the claim, the cap and the give-up capture, so the task
   * only interprets the outcome.
   */
  readonly delivery?: {
    deliverDue(periodStart: string): Promise<DueDelivery>
  }
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

        let itemsProcessed = 0
        // A stored row means nothing to generate — but delivery is still due (below).
        if (!(await deps.reports.exists(periodStart))) {
          const wrote = await deps.reports.generate(week, now)
          logger.info("weekly usage report", {
            periodStart,
            periodEnd: isoDay(week.end),
            stored: wrote,
          })
          if (wrote) itemsProcessed += 1
        }

        if (deps.delivery === undefined) {
          return { outcome: "success", itemsProcessed }
        }
        const due = await deps.delivery.deliverDue(periodStart)
        switch (due.action) {
          case "sent":
            logger.info("weekly usage report delivered", {
              periodStart,
              attempts: due.attempts,
            })
            return { outcome: "success", itemsProcessed: itemsProcessed + 1 }
          case "retry":
            logger.warn("weekly usage report delivery will retry", {
              periodStart,
              attempts: due.attempts,
              reason: due.reason,
            })
            return { outcome: "success", itemsProcessed }
          case "not_configured":
            // Log the transition only: every tick repeats this until the webhook is configured.
            if (due.recorded) {
              logger.info("weekly usage report delivery is not configured", { periodStart })
            }
            return { outcome: "success", itemsProcessed }
          case "failed":
            logger.error("weekly usage report delivery failed", {
              periodStart,
              attempts: due.attempts,
              reason: due.reason,
            })
            return { outcome: "failed", itemsProcessed, error: due.reason }
          case "skipped":
            return { outcome: "success", itemsProcessed }
        }
      } catch (error) {
        const reason = describeError(error, Number.POSITIVE_INFINITY)
        logger.error("weekly usage report failed", { error: reason })
        return { outcome: "failed", itemsProcessed: 0, error: reason }
      }
    },
  }
}
