import { describe, expect, test } from "bun:test"
import { classifyTaskHealth, toTaskStatusView } from "../../../src/services/settings"
import { harness, INTERVALS, MINUTE_MS, NOW, run } from "./fixtures"

/**
 * The task-health classifier is the whole point of the tasks surface: a sweep that silently stopped
 * produces no error and no log line, so this function is the only thing that notices. It is pure
 * with `now` injected, which is what makes every boundary below assertable without waiting.
 */

const INTERVAL = 60 * MINUTE_MS

function at(minutesAgo: number): Date {
  return new Date(NOW.getTime() - minutesAgo * MINUTE_MS)
}

function classify(
  lastRun: ReturnType<typeof run> | undefined,
  lastSuccess?: ReturnType<typeof run>,
) {
  return classifyTaskHealth({ lastRun, lastSuccess, intervalMs: INTERVAL, now: NOW })
}

describe("the five outcomes", () => {
  test("a task with no run row at all is never_run, not stale", () => {
    expect(classify(undefined)).toBe("never_run")
  })

  test("an open run inside one interval is running", () => {
    const open = run({ startedAt: at(30) })
    expect(classify(open)).toBe("running")
  })

  test("an open run older than one interval is stale — a wedged task must be visible", () => {
    const open = run({ startedAt: at(90) })
    expect(classify(open)).toBe("stale")
  })

  test("a last run that finished failed is failing", () => {
    const failed = run({ startedAt: at(10), finishedAt: at(9), outcome: "failed" })
    expect(
      classify(failed, run({ startedAt: at(20), finishedAt: at(19), outcome: "success" })),
    ).toBe("failing")
  })

  test("a last success older than two intervals is stale", () => {
    const finished = run({ startedAt: at(10), finishedAt: at(9), outcome: "partial" })
    const success = run({ startedAt: at(200), finishedAt: at(199), outcome: "success" })
    expect(classify(finished, success)).toBe("stale")
  })

  test("a recent success with a finished last run is ok", () => {
    const finished = run({ startedAt: at(10), finishedAt: at(9), outcome: "success" })
    expect(classify(finished, finished)).toBe("ok")
  })
})

describe("the two boundaries", () => {
  test("an open run at exactly one interval is still running; a millisecond later it is stale", () => {
    expect(classify(run({ startedAt: new Date(NOW.getTime() - INTERVAL) }))).toBe("running")
    expect(classify(run({ startedAt: new Date(NOW.getTime() - INTERVAL - 1) }))).toBe("stale")
  })

  test("a success at exactly two intervals is ok; a millisecond older is stale", () => {
    const finished = run({ startedAt: at(1), finishedAt: at(1), outcome: "success" })
    const onTheLine = run({
      startedAt: new Date(NOW.getTime() - 2 * INTERVAL),
      finishedAt: NOW,
      outcome: "success",
    })
    const past = run({
      startedAt: new Date(NOW.getTime() - 2 * INTERVAL - 1),
      finishedAt: NOW,
      outcome: "success",
    })
    expect(classify(finished, onTheLine)).toBe("ok")
    expect(classify(finished, past)).toBe("stale")
  })
})

describe("a finished run that never succeeded", () => {
  test("is stale: no success at all is older than any threshold", () => {
    const finished = run({ startedAt: at(1), finishedAt: at(1), outcome: "partial" })
    expect(classify(finished, undefined)).toBe("stale")
  })
})

describe("the task view", () => {
  test("renders the run in ISO, passes the scheduler's error through, and states the interval", () => {
    const view = toTaskStatusView({
      task: "oauth_state_purge",
      lastRun: run({
        startedAt: at(2),
        finishedAt: at(1),
        outcome: "failed",
        itemsProcessed: 812,
        error: "connection refused",
      }),
      lastSuccess: run({ startedAt: at(20), finishedAt: at(19), outcome: "success" }),
      intervalMs: 5 * MINUTE_MS,
      now: NOW,
    })

    expect(view).toEqual({
      task: "oauth_state_purge",
      intervalMinutes: 5,
      health: "failing",
      lastRun: {
        startedAt: at(2).toISOString(),
        finishedAt: at(1).toISOString(),
        outcome: "failed",
        itemsProcessed: 812,
        error: "connection refused",
      },
      lastSuccessAt: at(19).toISOString(),
    })
  })
})

describe("the tasks read", () => {
  test("lists every scheduled_task enum value, including one that has never run", async () => {
    const { service } = harness({
      runs: { janitor_sweep: [run({ startedAt: at(5), finishedAt: at(4), outcome: "success" })] },
    })
    const result = await service.tasks()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tasks.map((task) => task.task)).toEqual([
      "janitor_sweep",
      "usage_rollup",
      "oauth_state_purge",
      "quota_floor_refresh",
    ])

    const janitor = result.value.tasks[0]
    expect(janitor?.health).toBe("ok")
    expect(janitor?.intervalMinutes).toBe(INTERVALS.janitor_sweep / MINUTE_MS)

    const neverRan = result.value.tasks[1]
    expect(neverRan?.health).toBe("never_run")
    expect(neverRan?.lastRun).toBeNull()
    expect(neverRan?.lastSuccessAt).toBeNull()
  })
})
