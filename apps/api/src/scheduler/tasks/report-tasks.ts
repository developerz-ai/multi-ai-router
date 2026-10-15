import type { Env } from "../../config/env"
import { anchorOffsetMinutes } from "../../config/usage-report"
import type { ScheduledTask } from "../types"
import { createUsageWeeklyReportTask, type UsageWeeklyReportDeps } from "./usage-weekly-report"

/**
 * The report tasks, built from one set of seams so the registry stays a list (the same split as
 * `credential-tasks.ts`; `index.ts` is at the file cap).
 */
export interface ReportTaskDeps {
  /**
   * The weekly report service's `exists` and `generate`, handed in rather than rebuilt so the task
   * and the admin endpoints share one builder.
   */
  readonly usageReports: UsageWeeklyReportDeps["reports"]
  readonly env: Pick<Env, "usageReport">
}

export function createReportTasks(
  deps: ReportTaskDeps,
  intervals: { readonly usage_weekly_report: number },
): readonly ScheduledTask[] {
  return [
    createUsageWeeklyReportTask({
      reports: deps.usageReports,
      anchorOffsetMs: anchorOffsetMinutes(deps.env.usageReport) * 60_000,
      intervalMs: intervals.usage_weekly_report,
    }),
  ]
}
