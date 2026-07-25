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
  ScheduledTask,
  TaskContext,
  TaskLock,
  TaskOutcome,
  TickResult,
  TickStatus,
} from "./types"
