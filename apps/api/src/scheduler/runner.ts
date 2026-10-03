import {
  advisoryLockKey,
  type ScheduledTaskName,
  type ScheduledTaskRepository,
} from "@multi-ai-router/db"
import type { Logger } from "../logging/logger"
import { describe, indexTasks } from "./runner-support"
import type { ScheduledTask, TaskLock, TaskOutcome, TickResult } from "./types"

/** Jittered background tasks with distributed exclusion and bounded shutdown. */

export interface SchedulerDeps {
  /** Registry of periodic tasks. Names must be distinct — the lock key is derived from the name. */
  readonly tasks: readonly ScheduledTask[]
  readonly repo: ScheduledTaskRepository
  readonly logger: Logger
  readonly lock: TaskLock
  /** ±fraction of each interval. Config, never a constant (non-negotiable 11). */
  readonly shutdownDrainMs?: number
  readonly interruptedBatchSize?: number
  readonly capacityRetryMs?: number
  /** Off-path orphan maintenance, always outside the current task lock. */
  readonly beforeTick?: (signal: AbortSignal) => Promise<void>
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
  /** Disarms timers, aborts work, and drains within the configured budget. */
  stop(): Promise<void>
  /**
   * Runs one tick immediately, off the timer — the operator's "run now" and the
   * way a test drives a tick without waiting on a clock. Shares an in-flight
   * tick rather than starting a second one.
   */
  runNow(name: ScheduledTaskName): Promise<TickResult>
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date())
  const random = deps.random ?? Math.random
  const tasks = indexTasks(deps.tasks)
  const timers = new Map<ScheduledTaskName, ReturnType<typeof setTimeout>>()
  const fences = new Set<AbortController>()
  const inFlight = new Map<ScheduledTaskName, Promise<TickResult>>()
  let epoch = 0
  let stopping: Promise<void> | undefined
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
  const attempt = async (
    task: ScheduledTask,
    at: Date,
    logger: Logger,
    signal: AbortSignal,
  ): Promise<TaskOutcome> => {
    try {
      const outcome = await task.run({ now: at, logger, signal })
      return outcome.error === undefined ? outcome : { ...outcome, error: describe(outcome.error) }
    } catch (error) {
      return { outcome: "failed", itemsProcessed: 0, error: describe(error) }
    }
  }

  const tick = async (task: ScheduledTask): Promise<TickResult> => {
    const signal = abort.signal
    const fence = new AbortController()
    fences.add(fence)
    const startedAt = now()
    const logger = deps.logger.child({ component: "scheduler", task: task.name })
    const elapsed = (): number => now().getTime() - startedAt.getTime()

    try {
      await deps.beforeTick?.(signal)
      signal.throwIfAborted()
      const run = await deps.lock(
        advisoryLockKey(task.name),
        async (lockSignal) => {
          const taskSignal =
            lockSignal === undefined ? signal : AbortSignal.any([signal, lockSignal])
          taskSignal.throwIfAborted()
          const interruptedIds = await deps.repo.listInterruptedRunIds(
            task.name,
            startedAt,
            deps.interruptedBatchSize ?? 1000,
          )
          taskSignal.throwIfAborted()
          await deps.repo.markInterruptedRunIds(interruptedIds, startedAt)
          taskSignal.throwIfAborted()
          const runId = await deps.repo.begin(task.name, startedAt)
          const outcome = await attempt(task, startedAt, logger, taskSignal)
          lockSignal?.throwIfAborted()
          fence.signal.throwIfAborted()
          await deps.repo.finish(runId, outcome, now())
          return outcome
        },
        fence.signal,
      )

      if (!run.acquired) {
        const status = run.reason === "capacity" ? "skipped_capacity" : "skipped_locked"
        logger.debug("scheduled task skipped", { status })
        return {
          task: task.name,
          status,
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
      // task. Any unfinished run stays visible until a later owner reconciles it.
      const reason = describe(error)
      logger.error("scheduled task bookkeeping failed", { status: "failed", reason })
      return {
        task: task.name,
        status: "failed",
        itemsProcessed: 0,
        durationMs: elapsed(),
        error: reason,
      }
    } finally {
      fences.delete(fence)
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
        if (inFlight.get(task.name) === pending) inFlight.delete(task.name)
      })
    inFlight.set(task.name, pending)
    return pending
  }

  /**
   * Rescheduled only once the tick has settled, so the interval is a gap between
   * runs rather than a rate a slow sweep can fall behind.
   */
  const schedule = (task: ScheduledTask, delayMs = task.intervalMs): void => {
    const ownedEpoch = epoch
    const timer = setTimeout(() => {
      if (epoch !== ownedEpoch || !started || timers.get(task.name) !== timer) return
      timers.delete(task.name)
      // Always the full interval from here on: `startupDelayMs` describes the *first* gap only,
      // and a task that kept using it would be running on a cadence nobody configured.
      void run(task).then((result) => {
        if (started && epoch === ownedEpoch)
          schedule(
            task,
            result.status === "skipped_capacity"
              ? Math.min(task.intervalMs, deps.capacityRetryMs ?? 1000)
              : task.intervalMs,
          )
      })
    }, jitter(delayMs))
    // A sweep must never be the reason the process stays alive.
    timer.unref?.()
    timers.set(task.name, timer)
  }

  /** Resume the interval from the persisted last run, with lifecycle-owned startup lookup. */
  const scheduleFirst = async (task: ScheduledTask): Promise<void> => {
    const ownedEpoch = epoch
    let delayMs = task.startupDelayMs ?? task.intervalMs
    try {
      const last = await deps.repo.lastRun(task.name)
      if (last !== undefined) {
        delayMs = Math.max(0, task.intervalMs - (now().getTime() - last.startedAt.getTime()))
      }
    } catch (error) {
      deps.logger.warn("scheduled task last-run lookup failed; using the configured first gap", {
        component: "scheduler",
        task: task.name,
        reason: describe(error),
      })
    }
    // `stop()` may have won the race with this lookup; arming a timer now would outlive it.
    if (started && epoch === ownedEpoch) schedule(task, delayMs)
  }

  return {
    start() {
      if (started || stopping !== undefined || inFlight.size > 0) return
      epoch++
      started = true
      if (abort.signal.aborted) abort = new AbortController()
      for (const task of tasks.values()) void scheduleFirst(task)
      deps.logger.info("scheduler started", {
        component: "scheduler",
        tasks: [...tasks.keys()],
      })
    },

    stop() {
      if (stopping !== undefined) return stopping
      started = false
      epoch++
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      abort.abort()
      const budget = deps.shutdownDrainMs ?? 15_000
      let timer: ReturnType<typeof setTimeout> | undefined
      const owned = Promise.race([
        Promise.allSettled([...inFlight.values()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const fence of fences) fence.abort(new Error("scheduler drain deadline"))
            deps.logger.warn("scheduler drain timed out; interrupted runs remain visible", {
              component: "scheduler",
              tasks: [...inFlight.keys()],
            })
            resolve()
          }, budget)
        }),
      ])
        .then(() => undefined)
        .finally(() => {
          clearTimeout(timer)
          if (stopping === owned) stopping = undefined
        })
      stopping = owned
      return owned
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
