import type { ScheduledTaskRepository, SqlConnection } from "@multi-ai-router/db"
import type { Logger } from "../logging/logger"
import { advisoryTaskLock } from "./lock"
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
  /** The runner's own run log. Widened from the registry's read-only slice, which it satisfies. */
  readonly scheduledTasks: ScheduledTaskRepository
  /**
   * The pool behind the database handle. One consumer, here: an advisory lock lives on a *session*,
   * so a tick needs a connection it can reserve for the whole of its work.
   */
  readonly sql: SqlConnection
  readonly logger: Logger
  readonly now?: () => Date
  /** Called once per settled tick, including skips. Feeds the `router_task_*` series. */
  readonly onTick?: (result: TickResult) => void
}

export function schedulerFromEnv(deps: SchedulerFromEnvDeps): Scheduler {
  return createScheduler({
    tasks: createScheduledTasks(deps),
    repo: deps.scheduledTasks,
    lock: advisoryTaskLock(deps.sql),
    jitterFraction: deps.env.scheduler.jitterFraction,
    logger: deps.logger,
    now: deps.now,
    onTick: deps.onTick,
  })
}
