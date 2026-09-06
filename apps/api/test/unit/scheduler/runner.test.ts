import { describe, expect, test } from "bun:test"
import type { ScheduledTask } from "../../../src/scheduler"
import { createScheduler } from "../../../src/scheduler"
import {
  alwaysContended,
  alwaysFree,
  clock,
  memoryTaskRepository,
  NOW,
  silentLogger,
} from "./fixtures"

/**
 * The runner is the one place lock contention, the clock, and a task's own
 * throw all meet — see `src/scheduler/runner.ts`'s doc block for the three
 * properties it exists to guarantee. Every test here drives it through
 * `runNow`, the same deterministic tick trigger production exposes as
 * "run now" — real timers only enter the one test that is specifically about
 * self-rescheduling.
 */

function task(overrides: Partial<ScheduledTask> & Pick<ScheduledTask, "run">): ScheduledTask {
  return { name: "janitor_sweep", intervalMs: 60_000, ...overrides }
}

describe("lock contention", () => {
  test("a lock that never frees skips the tick and writes nothing", async () => {
    const repo = memoryTaskRepository()
    let calls = 0
    const t = task({
      run: async () => {
        calls += 1
        return { outcome: "success", itemsProcessed: 1 }
      },
    })
    const scheduler = createScheduler({
      tasks: [t],
      repo,
      logger: silentLogger(),
      lock: alwaysContended(),
      jitterFraction: 0,
    })

    const result = await scheduler.runNow(t.name)

    expect(result.status).toBe("skipped_locked")
    expect(result.itemsProcessed).toBe(0)
    expect(calls).toBe(0)
    expect(repo.rows).toHaveLength(0)
  })
})

describe("the injected clock", () => {
  test("stamps the run row and the duration, not the wall clock", async () => {
    const repo = memoryTaskRepository()
    const driven = clock(NOW)
    let observedNow: Date | undefined
    const t = task({
      run: async ({ now }) => {
        observedNow = now
        driven.advance(2_000)
        return { outcome: "success", itemsProcessed: 3 }
      },
    })
    const scheduler = createScheduler({
      tasks: [t],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
      now: driven.now,
    })

    const result = await scheduler.runNow(t.name)

    expect(observedNow).toEqual(NOW)
    expect(result.status).toBe("success")
    expect(result.durationMs).toBe(2_000)
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]?.startedAt).toEqual(NOW)
    expect(repo.rows[0]?.finishedAt).toEqual(driven.now())
  })
})

describe("a throwing task", () => {
  test("is recorded failed instead of escaping the tick", async () => {
    const repo = memoryTaskRepository()
    const t = task({
      run: async () => {
        throw new Error("boom")
      },
    })
    const scheduler = createScheduler({
      tasks: [t],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    const result = await scheduler.runNow(t.name)

    expect(result.status).toBe("failed")
    expect(result.error).toBe("boom")
    expect(repo.rows).toHaveLength(1)
    expect(repo.rows[0]?.outcome).toBe("failed")
  })

  test("persists the cause chain innermost first — the statement never crowds out the reason", async () => {
    // The audited failure: a drizzle wrapper whose message is 500 chars of statement text filled
    // the front-anchored budget on its own, and the driver's complaint one `cause` down — with a
    // credential in it, here — was discarded entirely.
    const repo = memoryTaskRepository()
    const t = task({
      run: async () => {
        throw new Error(`Failed query: insert into "usage_records" ${"$1, ".repeat(500)}`, {
          cause: new Error("connect failed: postgres://router:s3cret-pw@db.internal:5432/router"),
        })
      },
    })
    const scheduler = createScheduler({
      tasks: [t],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    const result = await scheduler.runNow(t.name)

    const persisted = repo.rows[0]?.error ?? ""
    expect(persisted).toStartWith("connect failed:")
    expect(persisted).toContain("Failed query")
    expect(persisted).not.toContain("s3cret-pw")
    expect(persisted.length).toBeLessThanOrEqual(500)
    expect(result.error).toStartWith("connect failed:")
  })

  test("still reschedules the next tick after failing", async () => {
    const repo = memoryTaskRepository()
    let calls = 0
    let resolveSecondCall: () => void = () => undefined
    const secondCall = new Promise<void>((resolve) => {
      resolveSecondCall = resolve
    })
    const t: ScheduledTask = {
      name: "janitor_sweep",
      // Real timers, deliberately: this is the one test asserting the timer
      // callback re-arms itself, not just that one tick's outcome is right.
      intervalMs: 15,
      run: async () => {
        calls += 1
        if (calls === 1) throw new Error("boom")
        resolveSecondCall()
        return { outcome: "success", itemsProcessed: 0 }
      },
    }
    const scheduler = createScheduler({
      tasks: [t],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    scheduler.start()
    try {
      await Promise.race([
        secondCall,
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("second tick never fired")), 2_000)
        }),
      ])
    } finally {
      await scheduler.stop()
    }

    expect(calls).toBeGreaterThanOrEqual(2)
    const outcomes = repo.rows
      .filter((row) => row.task === "janitor_sweep")
      .map((row) => row.outcome)
    expect(outcomes[0]).toBe("failed")
    expect(outcomes[1]).toBe("success")
  })
})

describe("one tick at a time", () => {
  test("two runNow calls for the same task share the in-flight tick", async () => {
    const repo = memoryTaskRepository()
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const t = task({
      run: async () => {
        calls += 1
        await gate
        return { outcome: "success", itemsProcessed: 5 }
      },
    })
    const scheduler = createScheduler({
      tasks: [t],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    const first = scheduler.runNow(t.name)
    const second = scheduler.runNow(t.name)
    release()
    const [a, b] = await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(a).toEqual(b)
    expect(repo.rows).toHaveLength(1)
  })

  test("runNow rejects a task name nothing registered", () => {
    const scheduler = createScheduler({
      tasks: [],
      repo: memoryTaskRepository(),
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    expect(() => scheduler.runNow("janitor_sweep")).toThrow(/no task named/)
  })
})

describe("the bookkeeping itself failing", () => {
  test("a lock/repo failure is reported failed without crashing the tick", async () => {
    const t = task({ run: async () => ({ outcome: "success", itemsProcessed: 1 }) })
    const scheduler = createScheduler({
      tasks: [t],
      repo: memoryTaskRepository(),
      logger: silentLogger(),
      lock: async () => {
        throw new Error("connection reset")
      },
      jitterFraction: 0,
    })

    const result = await scheduler.runNow(t.name)

    expect(result.status).toBe("failed")
    expect(result.error).toBe("connection reset")
  })
})

/**
 * `startupDelayMs` — the first gap only.
 *
 * It exists for one kind of task: the one whose output someone can see missing. A sweep that only
 * deletes rows can wait a full interval for its first tick because nothing is looking; a sweep that
 * populates `GET /v1/catalog` cannot, because an hour of `data: []` after a fresh deploy is
 * indistinguishable from a broken endpoint.
 *
 * Both halves are asserted, because the dangerous mistake is the second one: a task that kept using
 * the startup delay as its interval would run on a cadence nobody configured, and for a sweep that
 * makes outbound requests that is a self-inflicted rate problem rather than a cosmetic bug.
 */
describe("the first tick", () => {
  test("waits a full interval by default", async () => {
    const repo = memoryTaskRepository()
    let calls = 0
    const scheduler = createScheduler({
      tasks: [
        task({
          intervalMs: 5_000,
          run: async () => {
            calls += 1
            return { outcome: "success", itemsProcessed: 0 }
          },
        }),
      ],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    scheduler.start()
    // Well inside a five-second interval: a task with no startup delay must not have run.
    await new Promise((resolve) => setTimeout(resolve, 60))
    await scheduler.stop()

    expect(calls).toBe(0)
  })

  test("comes early when the task asks, and the interval takes over after it", async () => {
    const repo = memoryTaskRepository()
    const calls: number[] = []
    const started = Date.now()
    let resolveSecond: () => void = () => undefined
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })

    const scheduler = createScheduler({
      // Real timers: the point is which delay the runner armed, which no stub can show.
      tasks: [
        task({
          intervalMs: 40,
          startupDelayMs: 5,
          run: async () => {
            calls.push(Date.now() - started)
            if (calls.length === 2) resolveSecond()
            return { outcome: "success", itemsProcessed: 0 }
          },
        }),
      ],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    scheduler.start()
    try {
      await Promise.race([
        second,
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("the second tick never fired")), 2_000)
        }),
      ])
    } finally {
      await scheduler.stop()
    }

    // First tick on the startup delay, not the interval.
    expect(calls[0]).toBeLessThan(30)
    // Second on the interval: the startup delay describes the first gap and nothing after it.
    expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBeGreaterThanOrEqual(30)
  })
})

/**
 * A restart must not reset a long interval.
 *
 * The bug this pins cost three production subscriptions on 2026-09-06. `idle_account_probe` runs on
 * a 24-hour timer; the pod restarts more often than that; and because the first gap was measured
 * from process start rather than from the last recorded run, the sweep meant to notice a dying
 * credential had run **zero** times in a ten-hour-old pod. It was armed, reported as scheduled, and
 * never fired — the worst shape a safety net can take.
 *
 * `ScheduledTaskRun` already recorded every run. The scheduler simply never read what it wrote.
 */
describe("the first tick after a restart", () => {
  test("runs immediately when the interval already elapsed while the process was down", async () => {
    const repo = memoryTaskRepository()
    // A run that started well over an interval ago and finished.
    repo.rows.push({
      id: crypto.randomUUID(),
      task: "janitor_sweep",
      startedAt: new Date(Date.now() - 10_000),
      finishedAt: new Date(Date.now() - 9_000),
      outcome: "success",
      itemsProcessed: 0,
      error: null,
    })

    let calls = 0
    const scheduler = createScheduler({
      tasks: [
        task({
          name: "janitor_sweep",
          intervalMs: 5_000,
          run: async () => {
            calls += 1
            return { outcome: "success", itemsProcessed: 0 }
          },
        }),
      ],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    await scheduler.stop()

    // Due the moment the process came back, not five seconds later — and emphatically not never.
    expect(calls).toBe(1)
  })

  test("still waits out the remainder when the last run was recent", async () => {
    const repo = memoryTaskRepository()
    repo.rows.push({
      id: crypto.randomUUID(),
      task: "janitor_sweep",
      startedAt: new Date(Date.now() - 50),
      finishedAt: new Date(Date.now() - 40),
      outcome: "success",
      itemsProcessed: 0,
      error: null,
    })

    let calls = 0
    const scheduler = createScheduler({
      tasks: [
        task({
          name: "janitor_sweep",
          intervalMs: 5_000,
          run: async () => {
            calls += 1
            return { outcome: "success", itemsProcessed: 0 }
          },
        }),
      ],
      repo,
      logger: silentLogger(),
      lock: alwaysFree(),
      jitterFraction: 0,
    })

    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 80))
    await scheduler.stop()

    // A restart loop must not turn into a sweep loop.
    expect(calls).toBe(0)
  })
})
