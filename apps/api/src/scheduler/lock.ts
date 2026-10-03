import type { SchedulerLockPoolHandle } from "@multi-ai-router/db"
import type { TaskLock } from "./types"
/** Auxiliary scheduler pool; task repositories continue using the independent main pool. */
export function advisoryTaskLock(pool: SchedulerLockPoolHandle): TaskLock {
  return (key, work, signal = new AbortController().signal) =>
    pool.tryRun(key, signal, (lockSignal) => work(lockSignal))
}
