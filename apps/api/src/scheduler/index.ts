/**
 * The scheduler. Callers import from here; nothing outside this directory
 * reaches into a module inside it.
 *
 * Everything periodic in the router lives behind this barrel — in-process
 * jittered timers, one advisory lock per task, no broker (non-negotiable 13).
 */

export { advisoryTaskLock } from "./lock"
export type { Scheduler, SchedulerDeps } from "./runner"
export { createScheduler } from "./runner"
export type {
  JanitorDeps,
  OauthPurgeDeps,
  QuotaFloorDeps,
  ScheduledTaskDeps,
  Sweep,
  SweepOptions,
  SweepReport,
  UsageRollupDeps,
} from "./tasks"
export {
  createJanitorTask,
  createOauthPurgeTask,
  createQuotaFloorTask,
  createScheduledTasks,
  createUsageRollupTask,
  rollupFrom,
  runSweeps,
} from "./tasks"
export type {
  ScheduledTask,
  TaskContext,
  TaskLock,
  TaskOutcome,
  TickResult,
  TickStatus,
} from "./types"
