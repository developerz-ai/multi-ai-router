import type { ScheduledTaskName, ScheduledTaskRunRow } from "@multi-ai-router/db"
import type { TaskHealth, TaskRunView, TaskStatusView } from "./schema"

/**
 * Whether a background task is actually running.
 *
 * **A task that silently stops is the failure this surface exists to catch** — nothing else in the
 * system notices, because a sweep that never fires produces no error, no log line and no row. So
 * the classification is deliberately suspicious: silence past two intervals is `stale`, and an open
 * run past one interval is `stale` rather than `running`, because a wedged task holding its
 * advisory lock looks exactly like a busy one from the outside.
 *
 * Pure, with `now` and the interval injected. The interval comes from `scheduledTaskIntervals`, the
 * same function the running tasks are built from, never from a second reading of `Env`: a screen
 * that derived its own idea of the cadence would report health against a schedule nobody is
 * running.
 */

/** Silence longer than this many intervals is stale. Two, so one skipped tick is not an alarm. */
const STALE_AFTER_INTERVALS = 2

export interface TaskHealthInput {
  /** The newest run, finished or not. Absent means the task has never run on any replica. */
  readonly lastRun: ScheduledTaskRunRow | undefined
  /** The newest run that completed successfully. Absent means it never has. */
  readonly lastSuccess: ScheduledTaskRunRow | undefined
  readonly intervalMs: number
  readonly now: Date
}

export function classifyTaskHealth(input: TaskHealthInput): TaskHealth {
  const { lastRun, lastSuccess, intervalMs, now } = input
  if (lastRun === undefined) return "never_run"

  // An open run is the ambiguous case: still working, or killed halfway and never closed. One
  // interval is the line, because a second tick would have started by then on a healthy task.
  if (lastRun.finishedAt === null) {
    return elapsedSince(lastRun.startedAt, now) <= intervalMs ? "running" : "stale"
  }

  // `partial` is not a failure: it means the batch limit was hit and the next run continues.
  if (lastRun.outcome === "failed") return "failing"

  if (lastSuccess === undefined) return "stale"
  return elapsedSince(lastSuccess.startedAt, now) > STALE_AFTER_INTERVALS * intervalMs
    ? "stale"
    : "ok"
}

export interface TaskStatusInput extends TaskHealthInput {
  readonly task: ScheduledTaskName
}

export function toTaskStatusView(input: TaskStatusInput): TaskStatusView {
  return {
    task: input.task,
    intervalMinutes: toMinutes(input.intervalMs),
    health: classifyTaskHealth(input),
    lastRun: input.lastRun === undefined ? null : toTaskRunView(input.lastRun),
    lastSuccessAt: input.lastSuccess === undefined ? null : completedAt(input.lastSuccess),
  }
}

function toTaskRunView(row: ScheduledTaskRunRow): TaskRunView {
  return {
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    outcome: row.outcome,
    itemsProcessed: row.itemsProcessed,
    error: row.error,
  }
}

/**
 * `startedAt` is what the staleness clock reads, and it is the conservative choice for the same
 * reason the rollup's catch-up cursor takes it: a run covers the instant it began, not the instant
 * it finished. Displayed, though, "last succeeded" means completion — so the view uses `finishedAt`
 * and falls back to the start for a row that somehow lacks one.
 */
function completedAt(row: ScheduledTaskRunRow): string {
  return (row.finishedAt ?? row.startedAt).toISOString()
}

function elapsedSince(at: Date, now: Date): number {
  return now.getTime() - at.getTime()
}

const MINUTE_MS = 60_000

/** Milliseconds are the scheduler's unit; minutes are the operator's. Converted once, here. */
function toMinutes(intervalMs: number): number {
  return Math.round(intervalMs / MINUTE_MS)
}
