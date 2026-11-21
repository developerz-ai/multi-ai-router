import type { ScheduledTaskName } from "@multi-ai-router/db"
import type { Env } from "../config/env"
import { poolRosterCheckIntervalMs, scheduledTaskIntervals } from "../scheduler"

/**
 * Every cadence the settings screen judges task health against: `scheduledTaskIntervals(env)`, plus
 * `pool_roster_check` when a roster configured that task.
 *
 * Its own module so the admin plane's assembly (`composition/admin.ts`, already past the file cap)
 * does not grow for it — the same reason `composition/usage-reports.ts` exists.
 *
 * `pool_roster_check` is the one name whose existence depends on configuration, so its cadence is a
 * separate answer rather than a key `scheduledTaskIntervals` omits
 * (`scheduler/tasks/intervals.ts`). `null` means no roster, so no task, so no row belongs on the
 * screen; a number means the task is running in this process and the screen has to judge it like
 * any other.
 */
export function taskHealthIntervals(env: Env): Partial<Record<ScheduledTaskName, number>> {
  const rosterIntervalMs = poolRosterCheckIntervalMs(env)
  return {
    ...scheduledTaskIntervals(env),
    ...(rosterIntervalMs === null ? {} : { pool_roster_check: rosterIntervalMs }),
  }
}
