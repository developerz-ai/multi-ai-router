import type { ScheduledTaskRepository, SchedulerLockPoolHandle } from "@multi-ai-router/db"
import type { Env } from "../config/env"
import type { Logger } from "../logging/logger"
import { advisoryTaskLock } from "./lock"
import { createInterruptedRunMaintenance } from "./orphan-runs"
import { createScheduler, type Scheduler } from "./runner"
import { createScheduledTasks, type ScheduledTaskDeps } from "./tasks"
import type { TickResult } from "./types"

/**
 * The one place the scheduler becomes a *production* scheduler: the task registry built from env,
 * and the advisory lock bound to a real connection.
 *
 * It exists so the composition root can hand over repositories and stop there. `runner.ts` is
 * deliberately ignorant of Postgres — it takes a `TaskLock` capability and its tests need no
 * database — and that ignorance only holds if exactly one module knows to pair it with
 * `advisoryTaskLock`. This is that module, and it is why no service in the router is ever handed a
 * raw connection (non-negotiable 13).
 */

export interface SchedulerFromEnvDeps extends ScheduledTaskDeps {
  readonly env: ScheduledTaskDeps["env"] & Pick<Env, "background">
  /** The runner's own run log. Widened from the registry's read-only slice, which it satisfies. */
  readonly scheduledTasks: ScheduledTaskRepository
  /**
   * Independent auxiliary pool: a tick reserves its lock session while task repositories
   * retain access to the main database pool, including when its maximum is one.
   */
  readonly schedulerLock: SchedulerLockPoolHandle
  readonly logger: Logger
  readonly now?: () => Date
  /** Called once per settled tick, including skips. Feeds the `router_task_*` series. */
  readonly onTick?: (result: TickResult) => void
}

export function schedulerFromEnv(deps: SchedulerFromEnvDeps): Scheduler {
  const lock = advisoryTaskLock(deps.schedulerLock)
  return createScheduler({
    tasks: createScheduledTasks(deps),
    repo: deps.scheduledTasks,
    lock,
    beforeTick: createInterruptedRunMaintenance({
      repo: deps.scheduledTasks,
      lock,
      cutoffAgeMs: deps.env.retention.taskRunsDays * 24 * 60 * 60 * 1000,
      batchSize: deps.env.scheduler.sweepBatchSize,
      now: deps.now,
    }),
    jitterFraction: deps.env.scheduler.jitterFraction,
    shutdownDrainMs: deps.env.background.shutdownDrainMs,
    interruptedBatchSize: deps.env.scheduler.sweepBatchSize,
    logger: deps.logger,
    now: deps.now,
    onTick: deps.onTick,
  })
}
