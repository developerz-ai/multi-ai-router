import {
  advisoryLockKey,
  type ScheduledTaskName,
  type ScheduledTaskRepository,
} from "@multi-ai-router/db"
import type { TaskLock } from "./types"

/**
 * Historical tasks are inspected outside every current-task lock, including removed tasks.
 *
 * The runner calls this before every tick — including the one-second capacity retries while a long
 * run holds the lock session — so passes are single-flighted and spaced by `minGapMs`. The cutoff
 * is days old, so a gap of minutes delays nothing anyone can see.
 */
export function createInterruptedRunMaintenance(deps: {
  repo: Pick<
    ScheduledTaskRepository,
    "listInterruptedTasks" | "listInterruptedRunIds" | "markInterruptedRunIds"
  >
  lock: TaskLock
  cutoffAgeMs: number
  batchSize: number
  /** Least time between the starts of two passes. Absent or 0: every call runs one. */
  minGapMs?: number
  now?: () => Date
}): (signal: AbortSignal) => Promise<void> {
  const now = deps.now ?? (() => new Date())
  const minGapMs = deps.minGapMs ?? 0
  let cursor: ScheduledTaskName | undefined
  let inFlight: Promise<void> | undefined
  let lastPassAt: number | undefined
  return (signal) => {
    if (signal.aborted) return Promise.resolve()
    if (inFlight !== undefined) return inFlight
    const at = now().getTime()
    if (lastPassAt !== undefined && at - lastPassAt < minGapMs) return Promise.resolve()
    lastPassAt = at
    inFlight = pass(signal).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  async function pass(signal: AbortSignal): Promise<void> {
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
