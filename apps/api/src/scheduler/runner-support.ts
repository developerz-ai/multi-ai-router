import type { ScheduledTaskName } from "@multi-ai-router/db"
import { describeRedacted } from "../logging/redact"
import type { ScheduledTask, TaskContext, TaskOutcome } from "./types"

export function indexTasks(tasks: readonly ScheduledTask[]): Map<ScheduledTaskName, ScheduledTask> {
  const indexed = new Map<ScheduledTaskName, ScheduledTask>()
  for (const task of tasks) {
    if (indexed.has(task.name)) {
      // Two tasks under one name would share a lock key and silently serialize
      // against each other, which reads as "the second one never runs".
      throw new Error(`createScheduler: duplicate task name "${task.name}"`)
    }
    indexed.set(task.name, task)
  }
  return indexed
}

/**
 * Messages only — never a stack, never a query. This string is persisted and rendered.
 *
 * The whole `cause` chain, innermost first: a task failing on an ORM statement carries the
 * driver's complaint one `cause` down from a wrapper whose message *is* the statement text, and
 * front-anchored truncation of the wrapper alone persisted 500 chars of SQL with the actual
 * reason discarded. Redacted before the cap, so truncation cannot split a credential and leave
 * its tail in the persisted half. Lives in `logging/redact.ts` — the report delivery service
 * persists the same kind of string and must not import it from the scheduler layer.
 */
export const describe = describeRedacted

/**
 * One run, a throw converted into the `failed` outcome it deserves, and a run past `maxRunMs`
 * converted into one too: its signal is aborted so a cooperative task stops, and the caller gets
 * its outcome whether or not the task does — a hung await must not hold the replica's only lock
 * session (docs/idea/01-architecture.md, background work). Absent `maxRunMs`: unbounded.
 */
export async function runBounded(
  task: ScheduledTask,
  ctx: TaskContext,
  maxRunMs: number | undefined,
): Promise<TaskOutcome> {
  const deadline = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<TaskOutcome>((resolve) => {
    if (maxRunMs === undefined) return
    timer = setTimeout(() => {
      const error = `run exceeded ${maxRunMs} ms`
      deadline.abort(new Error(error))
      resolve({ outcome: "failed", itemsProcessed: 0, error })
    }, maxRunMs)
    timer.unref?.()
  })
  const settled = (async (): Promise<TaskOutcome> => {
    try {
      const outcome = await task.run({
        ...ctx,
        signal: AbortSignal.any([ctx.signal, deadline.signal]),
      })
      return outcome.error === undefined ? outcome : { ...outcome, error: describe(outcome.error) }
    } catch (error) {
      return { outcome: "failed", itemsProcessed: 0, error: describe(error) }
    }
  })()
  try {
    return await Promise.race([settled, expired])
  } finally {
    clearTimeout(timer)
  }
}
