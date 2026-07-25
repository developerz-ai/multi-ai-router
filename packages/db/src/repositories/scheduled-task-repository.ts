import { desc, eq } from "drizzle-orm"
import type { Database } from "../client"
import type { scheduledTask, scheduledTaskOutcome } from "../schema/enums"
import { type ScheduledTaskRunRow, scheduledTaskRuns } from "../schema/scheduled-task-runs"

/**
 * The scheduler's last-run record. Repositories own SQL; this file is the only
 * place that knows `scheduled_task_runs` is a table.
 *
 * Two statements, deliberately: {@link ScheduledTaskRepository.begin} writes the
 * row when the advisory lock is taken and
 * {@link ScheduledTaskRepository.finish} closes it when the work is done. A
 * single row written at the end would be indistinguishable from no run at all
 * whenever a task wedges or the process dies mid-sweep, which is precisely the
 * case an operator needs to see (docs/idea/09-deployment.md: a stale `startedAt`
 * with a NULL `finishedAt` means killed halfway or still holding the lock).
 *
 * A replica that loses the lock race writes nothing — it never calls `begin`, so
 * there is one row per *tick that ran*, not one per replica per tick.
 */
export interface ScheduledTaskRepository {
  /** Opens a run and returns its id. Call only after the advisory lock is held. */
  begin(task: ScheduledTaskName, now: Date): Promise<string>
  /**
   * Closes the run. `undefined` when no run has that id, which means someone
   * deleted the row underneath a live task rather than that the work failed.
   */
  finish(
    id: string,
    result: FinishScheduledTaskInput,
    now: Date,
  ): Promise<ScheduledTaskRunRow | undefined>
  /**
   * The most recent run of a task, finished or not — the health read behind the
   * admin surface, and the way a resumable task learns where it stopped.
   *
   * Deliberately *not* filtered to successful runs: "the last sweep failed" and
   * "the last sweep is still running" are the two answers worth having, and both
   * disappear if the query only ever returns a success.
   */
  lastRun(task: ScheduledTaskName): Promise<ScheduledTaskRunRow | undefined>
}

/** The four periodic tasks, from the `scheduled_task` Postgres enum. */
export type ScheduledTaskName = (typeof scheduledTask.enumValues)[number]

/** `partial` means the batch limit was hit and the next run continues. */
export type ScheduledTaskOutcome = (typeof scheduledTaskOutcome.enumValues)[number]

export interface FinishScheduledTaskInput {
  readonly outcome: ScheduledTaskOutcome
  /** Rows deleted or aggregated, in the task's own unit. Absent leaves the 0 `begin` wrote. */
  readonly itemsProcessed?: number
  /**
   * Message only, already redacted by the caller. Never a stack, never a query,
   * never credential material — this column is read straight onto an admin
   * screen.
   */
  readonly error?: string | null
}

export function createScheduledTaskRepository(db: Database): ScheduledTaskRepository {
  return {
    begin: async (task, now) => {
      const rows = await db
        .insert(scheduledTaskRuns)
        .values({ task, startedAt: now })
        .returning({ id: scheduledTaskRuns.id })
      const row = rows[0]
      if (row === undefined) {
        // An `insert ... returning` always yields its row; nothing here is a
        // request outcome, so this is a plain Error rather than a `RouterError`.
        throw new Error("scheduledTaskRepository.begin: statement returned no row")
      }
      return row.id
    },

    finish: async (id, result, now) => {
      const rows = await db
        .update(scheduledTaskRuns)
        .set({
          outcome: result.outcome,
          finishedAt: now,
          ...(result.itemsProcessed === undefined ? {} : { itemsProcessed: result.itemsProcessed }),
          ...(result.error === undefined ? {} : { error: result.error }),
        })
        .where(eq(scheduledTaskRuns.id, id))
        .returning()
      return rows[0]
    },

    lastRun: async (task) => {
      const rows = await db
        .select()
        .from(scheduledTaskRuns)
        .where(eq(scheduledTaskRuns.task, task))
        .orderBy(desc(scheduledTaskRuns.startedAt))
        .limit(1)
      return rows[0]
    },
  }
}
