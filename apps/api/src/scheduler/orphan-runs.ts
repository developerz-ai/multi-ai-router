import {
  advisoryLockKey,
  type ScheduledTaskName,
  type ScheduledTaskRepository,
} from "@multi-ai-router/db"
import type { TaskLock } from "./types"

/** Historical tasks are inspected outside every current-task lock, including removed tasks. */
export function createInterruptedRunMaintenance(deps: {
  repo: Pick<
    ScheduledTaskRepository,
    "listInterruptedTasks" | "listInterruptedRunIds" | "markInterruptedRunIds"
  >
  lock: TaskLock
  cutoffAgeMs: number
  batchSize: number
  now?: () => Date
}): (signal: AbortSignal) => Promise<void> {
  const now = deps.now ?? (() => new Date())
  let cursor: ScheduledTaskName | undefined
  return async (signal) => {
    if (signal.aborted) return
    const cutoff = new Date(now().getTime() - deps.cutoffAgeMs)
    let tasks = await deps.repo.listInterruptedTasks(cutoff, deps.batchSize, cursor)
    if (tasks.length === 0 && cursor !== undefined && !signal.aborted) {
      cursor = undefined
      tasks = await deps.repo.listInterruptedTasks(cutoff, deps.batchSize)
    }
    for (const task of tasks) {
      if (signal.aborted) return
      cursor = task
      await deps.lock(
        advisoryLockKey(task),
        async (lockSignal) => {
          if (signal.aborted || lockSignal?.aborted) return
          // Age only selects candidates. Owning the same task lock proves no live owner remains.
          const ids = await deps.repo.listInterruptedRunIds(task, cutoff, deps.batchSize)
          if (signal.aborted || lockSignal?.aborted) return
          await deps.repo.markInterruptedRunIds(ids, now())
        },
        signal,
      )
    }
  }
}
