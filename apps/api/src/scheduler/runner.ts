import { describeError } from "@multi-ai-router/core"
import {
  advisoryLockKey,
  type ScheduledTaskName,
  type ScheduledTaskRepository,
} from "@multi-ai-router/db"
import type { Logger } from "../logging/logger"
import { redactValue } from "../logging/redact"
import type { ScheduledTask, TaskLock, TaskOutcome, TickResult } from "./types"

/**
 * The periodic-task runner: in-process jittered timers, one Postgres advisory
 * lock per task, one `scheduled_task_runs` row per tick that actually ran.
 * There is no broker, no worker container, and no system cron — the rationale is
 * recorded in docs/idea/01-architecture.md, "Background work and scheduling".
 *
 * Three properties this file exists to guarantee, so no task has to:
 *
 * - **Exactly one replica runs a given tick.** `pg_try_advisory_lock` is taken
 *   before any work; a replica that loses returns `skipped_locked` instantly and
 *   writes nothing. Leader election without a leader-election system.
 * - **A wedged task is visible.** The run row is opened *before* the work and
 *   closed after, so a process killed mid-sweep leaves a stale `startedAt` with
 *   a NULL `finishedAt` — which is the state an operator needs to see, and the
 *   state a single row written at the end would erase.
 * - **An error never escapes a tick.** A task that throws is recorded as
 *   `failed` with its message, logged, and rescheduled. A periodic timer must
 *   not be able to take the process down, and the next tick is the retry.
 *
 * Deliberately *not* the catalog refresh, which is the other timer in this
 * process and the opposite of this one in every respect: no lock, every replica,
 * no row (docs/idea/08-observability.md, "The catalog refresh is not a
 * scheduled task").
 */

export interface SchedulerDeps {
  /** Registry of periodic tasks. Names must be distinct — the lock key is derived from the name. */
  readonly tasks: readonly ScheduledTask[]
  readonly repo: ScheduledTaskRepository
  readonly logger: Logger
  readonly lock: TaskLock
  /** ±fraction of each interval. Config, never a constant (non-negotiable 11). */
  readonly jitterFraction: number
  readonly now?: () => Date
  /** Injected so a test is deterministic; production leaves it alone. */
  readonly random?: () => number
  /**
   * Called once per settled tick, including the ones that skipped on a lost lock. Feeds the
   * `router_task_*` series; it must not throw, and it is never awaited.
   */
  readonly onTick?: (result: TickResult) => void
}

export interface Scheduler {
  /** Arms every task's timer. Idempotent — a second call is a no-op, not a second set of timers. */
  start(): void
  /** Disarms the timers, aborts in-flight work, and waits for it. Safe to call unstarted. */
  stop(): Promise<void>
  /**
   * Runs one tick immediately, off the timer — the operator's "run now" and the
   * way a test drives a tick without waiting on a clock. Shares an in-flight
   * tick rather than starting a second one.
   */
  runNow(name: ScheduledTaskName): Promise<TickResult>
}

/**
 * Ceiling on the message persisted to `scheduled_task_runs.error` and rendered
 * on the settings screen. Not an operator knob: it bounds a column, it does not
 * express a policy.
 */
const MAX_ERROR_CHARS = 500

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? Math.random
  const tasks = indexTasks(deps.tasks)
  const timers = new Map<ScheduledTaskName, ReturnType<typeof setTimeout>>()
  const inFlight = new Map<ScheduledTaskName, Promise<TickResult>>()
  let started = false
  let abort = new AbortController()

  /**
   * Jitter is not decoration. Replicas restart together, and under a fixed
   * interval they would contend for the same lock at the same instant for the
   * life of the deployment, aligning every sweep with every other sweep.
   */
  const jitter = (intervalMs: number): number => {
    const spread = 1 - deps.jitterFraction + random() * 2 * deps.jitterFraction
    return Math.max(1, Math.round(intervalMs * spread))
  }

  /** Runs the task, converting a throw into the `failed` row it deserves. */
  const attempt = async (task: ScheduledTask, at: Date, logger: Logger): Promise<TaskOutcome> => {
    try {
      const outcome = await task.run({ now: at, logger, signal: abort.signal })
      return outcome.error === undefined ? outcome : { ...outcome, error: describe(outcome.error) }
    } catch (error) {
      return { outcome: "failed", itemsProcessed: 0, error: describe(error) }
    }
  }

  const tick = async (task: ScheduledTask): Promise<TickResult> => {
    const startedAt = now()
    const logger = deps.logger.child({ component: "scheduler", task: task.name })
    const elapsed = (): number => now().getTime() - startedAt.getTime()

    try {
      const run = await deps.lock(advisoryLockKey(task.name), async () => {
        const runId = await deps.repo.begin(task.name, startedAt)
        const outcome = await attempt(task, startedAt, logger)
        await deps.repo.finish(runId, outcome, now())
        return outcome
      })

      if (!run.acquired) {
        logger.debug("scheduled task skipped", { status: "skipped_locked" })
        return {
          task: task.name,
          status: "skipped_locked",
          itemsProcessed: 0,
          durationMs: elapsed(),
        }
      }

      const { outcome, itemsProcessed, error } = run.value
      const durationMs = elapsed()
      const fields = {
        status: outcome,
        itemsProcessed,
        durationMs,
        ...(error === undefined ? {} : { reason: error }),
      }
      if (outcome === "failed") logger.error("scheduled task failed", fields)
      else logger.info("scheduled task ran", fields)
      return {
        task: task.name,
        status: outcome,
        itemsProcessed,
        durationMs,
        ...(error === undefined ? {} : { error }),
      }
    } catch (error) {
      // The bookkeeping itself fell over — the lock or the run row, not the
      // task. Nothing was recorded and nothing can be; the next tick retries.
      const reason = describe(error)
      logger.error("scheduled task bookkeeping failed", { status: "failed", reason })
      return {
        task: task.name,
        status: "failed",
        itemsProcessed: 0,
        durationMs: elapsed(),
        error: reason,
      }
    }
  }

  /** One tick per task at a time: a sweep slower than its interval must not lap itself. */
  const run = (task: ScheduledTask): Promise<TickResult> => {
    const existing = inFlight.get(task.name)
    if (existing !== undefined) return existing
    const pending = tick(task)
      .then((result) => {
        deps.onTick?.(result)
        return result
      })
      .finally(() => {
        inFlight.delete(task.name)
      })
    inFlight.set(task.name, pending)
    return pending
  }

  /**
   * Rescheduled only once the tick has settled, so the interval is a gap between
   * runs rather than a rate a slow sweep can fall behind.
   */
  const schedule = (task: ScheduledTask, delayMs = task.intervalMs): void => {
    const timer = setTimeout(() => {
      // Always the full interval from here on: `startupDelayMs` describes the *first* gap only,
      // and a task that kept using it would be running on a cadence nobody configured.
      void run(task).finally(() => {
        if (started) schedule(task)
      })
    }, jitter(delayMs))
    // A sweep must never be the reason the process stays alive.
    timer.unref?.()
    timers.set(task.name, timer)
  }

  return {
    start() {
      if (started) return
      started = true
      if (abort.signal.aborted) abort = new AbortController()
      for (const task of tasks.values()) schedule(task, task.startupDelayMs ?? task.intervalMs)
      deps.logger.info("scheduler started", {
        component: "scheduler",
        tasks: [...tasks.keys()],
      })
    },

    async stop() {
      started = false
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      abort.abort()
      // Waiting matters: an in-flight tick holds an advisory lock on a reserved
      // connection, and shutdown closes the pool next.
      await Promise.allSettled([...inFlight.values()])
    },

    runNow(name) {
      const task = tasks.get(name)
      if (task === undefined) {
        // A caller naming a task that was never registered is a wiring bug, not
        // a request outcome — hence a plain Error, not a `RouterError`.
        throw new Error(`createScheduler: no task named "${name}" is registered`)
      }
      return run(task)
    },
  }
}

function indexTasks(tasks: readonly ScheduledTask[]): Map<ScheduledTaskName, ScheduledTask> {
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
 * its tail in the persisted half.
 */
function describe(error: unknown): string {
  const scrubbed = redactValue(describeError(error, Number.POSITIVE_INFINITY))
  return scrubbed.length <= MAX_ERROR_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_ERROR_CHARS - 1)}…`
}
