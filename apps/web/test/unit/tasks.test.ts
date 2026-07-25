import { describe, expect, test } from "bun:test"
import {
  describeTaskRun,
  needsAttention,
  type TaskHealth,
  type TaskHealthRow,
  taskHealthLabel,
  taskHealthTone,
  taskLabel,
} from "../../src/lib/api/tasks"

/**
 * How a scheduled-task run becomes a sentence an operator can act on.
 *
 * The clock is a parameter, never `Date.now()` — the same rule `lib/reset-countdown.ts` follows,
 * and the reason a task that has never run cannot accidentally acquire a plausible timestamp.
 */

const NOW = Date.parse("2026-07-25T12:00:00.000Z")

const taskRow = (row: Partial<TaskHealthRow>): TaskHealthRow => ({
  task: "janitor_sweep",
  intervalMinutes: 60,
  health: "ok",
  lastRun: null,
  lastSuccessAt: null,
  ...row,
})

describe("task health", () => {
  const HEALTHS: readonly TaskHealth[] = ["ok", "running", "stale", "failing", "never_run"]

  test("every state has a sentence and a tone, so no cell renders a raw key", () => {
    for (const health of HEALTHS) {
      expect(taskHealthLabel(health).length).toBeGreaterThan(0)
      expect(taskHealthTone(health).length).toBeGreaterThan(0)
    }
  })

  test("the three states that mean a task may have stopped are the ones called out", () => {
    expect(HEALTHS.filter(needsAttention)).toEqual(["stale", "failing", "never_run"])
  })

  test("the scheduled_task enum values all have a label, and an unknown one is humanised", () => {
    expect(taskLabel("janitor_sweep")).toBe("Janitor")
    expect(taskLabel("usage_rollup")).toBe("Usage rollup")
    expect(taskLabel("oauth_state_purge")).toBe("OAuth state purge")
    expect(taskLabel("quota_floor_refresh")).toBe("Quota floor refresh")
    expect(taskLabel("some_new_sweep")).toBe("Some new sweep")
  })
})

describe("describeTaskRun", () => {
  test("says what happened, in plain language, with the items it processed", () => {
    const row = taskRow({
      lastRun: {
        startedAt: "2026-07-25T11:56:00.000Z",
        finishedAt: "2026-07-25T11:56:04.000Z",
        outcome: "success",
        itemsProcessed: 812,
        error: null,
      },
    })
    expect(describeTaskRun(row, NOW)).toBe("Janitor last ran 4m ago, 812 rows deleted.")
  })

  test("a run still in flight is not reported as finished", () => {
    const row = taskRow({
      health: "running",
      lastRun: {
        startedAt: "2026-07-25T11:59:00.000Z",
        finishedAt: null,
        outcome: null,
        itemsProcessed: 0,
        error: null,
      },
    })
    expect(describeTaskRun(row, NOW)).toBe("Janitor started 1m ago and is still running.")
  })

  test("a failure says so rather than leaving it to the outcome column", () => {
    const row = taskRow({
      task: "usage_rollup",
      health: "failing",
      lastRun: {
        startedAt: "2026-07-25T11:00:00.000Z",
        finishedAt: "2026-07-25T11:00:01.000Z",
        outcome: "failed",
        itemsProcessed: 0,
        error: "connection terminated",
      },
    })
    expect(describeTaskRun(row, NOW)).toBe(
      "Usage rollup last ran 1h ago and failed after 0 records rolled up.",
    )
  })

  test("a task that never ran gets no countdown and no invented timestamp", () => {
    const sentence = describeTaskRun(taskRow({ health: "never_run" }), NOW)
    expect(sentence).toBe("Janitor has not run yet.")
    // Nothing shaped like an observation nobody made: no relative time, no clock reading.
    expect(sentence).not.toMatch(/ago|in \d|\d{4}-\d{2}-\d{2}/)
  })
})
