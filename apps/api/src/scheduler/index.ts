/**
 * The scheduler. Callers import from here; nothing outside this directory
 * reaches into a module inside it.
 *
 * Everything periodic in the router lives behind this barrel — in-process
 * jittered timers, one advisory lock per task, no broker (non-negotiable 13).
 */

export type { SchedulerFromEnvDeps } from "./fromEnv"
export { schedulerFromEnv } from "./fromEnv"
export { advisoryTaskLock } from "./lock"
export type { Scheduler, SchedulerDeps } from "./runner"
export { createScheduler } from "./runner"
export type {
  AdminSessionPurgeDeps,
  AdminSessionStoreForPurge,
  ConfigDirReapDeps,
  JanitorDeps,
  ModelCatalogRefreshDeps,
  OauthPurgeDeps,
  OrphanConfigDir,
  QuotaFloorDeps,
  ReapPlan,
  ReapPlanInput,
  ScheduledTaskDeps,
  Sweep,
  SweepOptions,
  SweepReport,
  UsageRollupDeps,
} from "./tasks"
export {
  createAdminSessionPurgeTask,
  createConfigDirReapTask,
  createIdleAccountProbeTask,
  createJanitorTask,
  createModelCatalogRefreshTask,
  createOauthPurgeTask,
  createQuotaFloorTask,
  createScheduledTasks,
  createUsageRollupTask,
  IDLE_PROBE_MODELS,
  planConfigDirReap,
  rollupDays,
  rollupFrom,
  runSweeps,
  scheduledTaskIntervals,
} from "./tasks"
export type {
  ScheduledTask,
  TaskContext,
  TaskLock,
  TaskOutcome,
  TickResult,
  TickStatus,
} from "./types"
