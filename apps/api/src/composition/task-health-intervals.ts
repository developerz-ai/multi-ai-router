import type { ScheduledTaskName } from "@multi-ai-router/db"
import type { Env } from "../config/env"
import { poolRosterCheckIntervalMs, scheduledTaskIntervals } from "../scheduler"

/**
 * Every cadence the settings screen judges task health against: `scheduledTaskIntervals(env)`, plus
 * `egress_proxy_check` and, when a roster configured that task, `pool_roster_check`.
 *
 * Its own module so the admin plane's assembly (`composition/admin.ts`, already past the file cap)
 * does not grow for it — the same reason `composition/usage-reports.ts` exists.
 *
 * `pool_roster_check` is the name whose existence depends on configuration, so its cadence is a
 * separate answer rather than a key `scheduledTaskIntervals` omits
 * (`scheduler/tasks/intervals.ts`). `null` means no roster, so no task, so no row belongs on the
 * screen; a number means the task is running in this process and the screen has to judge it like
 * any other.
 */
export function taskHealthIntervals(env: Env): Partial<Record<ScheduledTaskName, number>> {
  const rosterIntervalMs = poolRosterCheckIntervalMs(env)
  return {
    ...scheduledTaskIntervals(env),
    // Carried by its port rather than listed (`scheduler/tasks/intervals.ts`); it always runs here.
    egress_proxy_check: env.egressProxy.checkIntervalMinutes * 60_000,
    ...(rosterIntervalMs === null ? {} : { pool_roster_check: rosterIntervalMs }),
  }
}
