import type { AdvisoryLockRun, ScheduledTaskName, ScheduledTaskOutcome } from "@multi-ai-router/db"
import type { Logger } from "../logging/logger"

/**
 * The vocabulary the scheduler and its tasks share.
 *
 * A task is a plain object, not a class and not a subclass of anything: a name
 * drawn from the `scheduled_task` Postgres enum, an interval, and one async
 * function. Everything a task needs to be *safe* — the advisory lock, the
 * `scheduled_task_runs` row, the jitter, the swallowing of its own throw — is
 * the runner's job, so a task file contains only the sweep it is named after.
 *
 * The contract every task owes back (docs/idea/01-architecture.md, "Background
 * work and scheduling"): **idempotent, resumable, and bounded-batch.** Safe to
 * run twice, safe to kill halfway, and never one giant transaction — the data
 * plane must not feel a sweep.
 */

/** What a task is handed on each tick. Everything impure it is allowed to touch. */
export interface TaskContext {
  /** The tick's clock reading — the same instant that opened the run row. */
  readonly now: Date
  /** Already stamped with `component: "scheduler"` and this task's name. */
  readonly logger: Logger
  /**
   * Aborted by `stop()`. A bounded-batch loop checks it between batches, which
   * is what keeps shutdown prompt while a long sweep is mid-flight.
   */
  readonly signal: AbortSignal
}

/**
 * What a task reports. `partial` is not a failure — it means the batch limit was
 * hit and there is more left, so the next tick continues where this one stopped.
 */
export interface TaskOutcome {
  readonly outcome: ScheduledTaskOutcome
  /** Rows deleted or aggregated, in the task's own unit. */
  readonly itemsProcessed: number
  /** Message only. Redacted and truncated by the runner before it is persisted. */
  readonly error?: string
}

export interface ScheduledTask {
  readonly name: ScheduledTaskName
  /** Nominal gap between runs. Config, never a constant (non-negotiable 11). Jittered by the runner. */
  readonly intervalMs: number
  /**
   * How long after `start()` the **first** tick runs. Absent means one full jittered interval,
   * which is the right default for every task that deletes or rolls up: nothing is waiting on it,
   * and sweeping at boot is work a restart loop would repeat.
   *
   * A task states this only when its output is something a reader can *see missing*. The model
   * catalog is the case: it populates a public listing, so an hour of `data: []` after a fresh
   * deploy looks exactly like a broken endpoint rather than a sweep that has not come round yet.
   *
   * Jittered like any other delay, so replicas restarting together do not converge on one instant.
   */
  readonly startupDelayMs?: number
  run(ctx: TaskContext): Promise<TaskOutcome>
}

/**
 * `skipped_locked` is the normal outcome on every replica that lost the advisory
 * lock race — not an error, and never a `scheduled_task_runs` row. It is a
 * distinct label on `router_task_runs_total`
 * (docs/idea/08-observability.md#scheduled-task-visibility) precisely so nobody
 * alerts on it.
 */
export type TickStatus = ScheduledTaskOutcome | "skipped_locked"

/** The result of one tick, whether it ran, skipped, or fell over. */
export interface TickResult {
  readonly task: ScheduledTaskName
  readonly status: TickStatus
  readonly itemsProcessed: number
  readonly durationMs: number
  readonly error?: string
}

/**
 * Taking the per-task lock, as a capability rather than a connection.
 *
 * The scheduler is a service, and services do not hold a `SqlConnection` — the
 * production implementation is `advisoryTaskLock(sql)` in `lock.ts`, which is a
 * one-line binding of `withAdvisoryLock`. Injecting the capability is also what
 * lets the contention tests run without a database: a lock that always answers
 * `{ acquired: false }` is the second replica, exactly.
 */
export type TaskLock = <T>(key: number, work: () => Promise<T>) => Promise<AdvisoryLockRun<T>>
