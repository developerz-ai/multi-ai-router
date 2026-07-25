import type {
  AdvisoryLockRun,
  FinishScheduledTaskInput,
  ScheduledTaskName,
  ScheduledTaskRepository,
  ScheduledTaskRunRow,
} from "@multi-ai-router/db"
import { createLogger, type Logger } from "../../../src/logging/logger"
import type { TaskLock } from "../../../src/scheduler"

/**
 * Shared doubles for the scheduler's unit tests: a driven clock, a silent
 * logger, the two `TaskLock` shapes a replica can be in (holds it / loses the
 * race), an in-memory `ScheduledTaskRepository`, and a bounded-batch age
 * bucket standing in for a repository's `delete*` method.
 *
 * The repository double implements the real interface rather than recording
 * calls — the house pattern (`apps/api/test/support/memory-store.ts`) — so a
 * test asserts on rows the runner actually wrote, not on which methods it
 * happened to invoke.
 */

export const NOW = new Date("2026-07-25T00:00:00.000Z")

/** A `now()` a test advances by hand, instead of racing the real clock. */
export function clock(start: Date = NOW): { now: () => Date; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

export function silentLogger(): Logger {
  return createLogger({ level: "error", write: () => undefined })
}

/** The losing replica: never runs the work, never acquires. */
export function alwaysContended(): TaskLock {
  return async () => ({ acquired: false })
}

/** The only replica in the room: always runs the work under the "lock". */
export function alwaysFree(): TaskLock {
  return async <T>(_key: number, work: () => Promise<T>): Promise<AdvisoryLockRun<T>> => ({
    acquired: true,
    value: await work(),
  })
}

export interface MemoryTaskRepository extends ScheduledTaskRepository {
  /** The rows themselves, for assertions — mirrors `MemoryStore.rows`. */
  readonly rows: ScheduledTaskRunRow[]
}

/** The runner's own bookkeeping store: real `begin`/`finish`/`lastRun`/`lastSuccess` semantics, no database. */
export function memoryTaskRepository(): MemoryTaskRepository {
  const rows: ScheduledTaskRunRow[] = []

  return {
    rows,

    begin: async (task: ScheduledTaskName, now: Date) => {
      const id = crypto.randomUUID()
      rows.push({
        id,
        task,
        startedAt: now,
        finishedAt: null,
        outcome: null,
        itemsProcessed: 0,
        error: null,
      })
      return id
    },

    finish: async (id: string, result: FinishScheduledTaskInput, now: Date) => {
      const index = rows.findIndex((row) => row.id === id)
      if (index === -1) return undefined
      const current = rows[index]
      if (current === undefined) return undefined
      const next: ScheduledTaskRunRow = {
        ...current,
        outcome: result.outcome,
        finishedAt: now,
        itemsProcessed: result.itemsProcessed ?? current.itemsProcessed,
        error: result.error ?? current.error,
      }
      rows[index] = next
      return next
    },

    lastRun: async (task: ScheduledTaskName) =>
      [...rows].reverse().find((row) => row.task === task),

    lastSuccess: async (task: ScheduledTaskName) =>
      [...rows].reverse().find((row) => row.task === task && row.outcome === "success"),
  }
}

export interface AgeBucket {
  /** Oldest first, bounded by `limit` — the shape every `delete*` repository method shares. */
  readonly deleteBatch: (cutoff: Date, limit: number) => Promise<number>
  readonly remaining: () => number
}

/** A bounded-batch delete target: `ages.length` rows, each aged by its own timestamp. */
export function ageBucket(ages: readonly Date[]): AgeBucket {
  // Oldest first. Callers routinely pass the same `Date` instance for several
  // rows (one fixture constant standing in for "N old rows"), so removal below
  // is by count, not by matching a value — matching by reference would collapse
  // duplicates via `Set`, and matching by timestamp would delete every row that
  // shares one instead of just the batch.
  let rows = [...ages].sort((a, b) => a.getTime() - b.getTime())
  return {
    deleteBatch: async (cutoff, limit) => {
      const eligible = rows.filter((age) => age.getTime() <= cutoff.getTime()).length
      const batch = Math.min(eligible, limit)
      rows = rows.slice(batch)
      return batch
    },
    remaining: () => rows.length,
  }
}
