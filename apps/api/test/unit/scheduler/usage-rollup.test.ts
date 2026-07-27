import { describe, expect, test } from "bun:test"
import { startOfNextUtcDay, startOfUtcDay } from "@multi-ai-router/db"
import type { RetentionConfig } from "../../../src/config/env"
import { createUsageRollupTask, rollupDays, rollupFrom } from "../../../src/scheduler"
import { silentLogger, successRun } from "./fixtures"

/**
 * `rollupFrom` and `rollupDays` are tested directly first — pure functions of a
 * clock and a row, exactly the "no mocks, inject the snapshot" shape the house
 * style asks for. `createUsageRollupTask` is then tested for what is not window
 * arithmetic: that the window is issued one statement per day rather than one
 * across all of them, that a shutdown lands between two of them, and that the
 * no-op stays a no-op.
 *
 * A time that is not UTC midnight, deliberately — `NOW` at 00:00:00.000Z would
 * make "yesterday" and "today" collide and hide the boundary this task exists
 * to get right.
 */
const NOW = new Date("2026-07-25T14:30:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1_000

describe("rollupFrom: the scan window", () => {
  test("with no prior success, backfills to the retention floor", () => {
    const retention: Pick<RetentionConfig, "usageDays"> = { usageDays: 30 }
    const from = rollupFrom(NOW, undefined, { retention })

    const floor = startOfNextUtcDay(new Date(NOW.getTime() - retention.usageDays * DAY_MS))
    expect(from).toEqual(floor)
  })

  test("a recent successful run still re-closes yesterday, not just today", () => {
    const retention: Pick<RetentionConfig, "usageDays"> = { usageDays: 30 }
    const lastSuccess = { startedAt: new Date(NOW.getTime() - 5 * 60 * 1_000) }
    const from = rollupFrom(NOW, lastSuccess, { retention })

    const yesterday = new Date(startOfUtcDay(NOW).getTime() - DAY_MS)
    expect(from).toEqual(yesterday)
  })

  test("a short retention window pulls the floor forward past yesterday", () => {
    // A one-day window puts the floor inside today — later than "yesterday" —
    // so even a recent successful run must not resume from before it.
    const retention: Pick<RetentionConfig, "usageDays"> = { usageDays: 1 }
    const lastSuccess = { startedAt: new Date(NOW.getTime() - 5 * 60 * 1_000) }
    const from = rollupFrom(NOW, lastSuccess, { retention })

    const floor = startOfNextUtcDay(new Date(NOW.getTime() - retention.usageDays * DAY_MS))
    const yesterday = new Date(startOfUtcDay(NOW).getTime() - DAY_MS)
    expect(floor.getTime()).toBeGreaterThan(yesterday.getTime())
    expect(from).toEqual(floor)
  })
})

describe("rollupDays: the batches, and their order", () => {
  test("a backfill is one day per statement, oldest first, ending on today", () => {
    const from = new Date("2026-07-22T00:00:00.000Z")

    expect(rollupDays(from, NOW)).toEqual([
      new Date("2026-07-22T00:00:00.000Z"),
      new Date("2026-07-23T00:00:00.000Z"),
      new Date("2026-07-24T00:00:00.000Z"),
      new Date("2026-07-25T00:00:00.000Z"),
    ])
  })

  test("a `from` inside today still yields today, not nothing", () => {
    // The steady state: the cursor sits a few minutes back, and today is still
    // rescanned in full because the day is the unit that can be replaced.
    expect(rollupDays(new Date(NOW.getTime() - 5 * 60_000), NOW)).toEqual([
      startOfUtcDay(NOW),
    ] as readonly Date[])
  })

  test("a `from` at or past `now` yields no statement at all", () => {
    expect(rollupDays(NOW, NOW)).toEqual([])
    expect(rollupDays(new Date(NOW.getTime() + DAY_MS), NOW)).toEqual([])
  })
})

/** Records every day the task asked for, and answers with a fixed row count. */
function recordingRollup(rowsPerDay: number, onDay?: (day: Date) => void) {
  const days: Date[] = []
  return {
    days,
    usageDaily: {
      rollupDay: async (day: Date) => {
        days.push(day)
        onDay?.(day)
        return rowsPerDay
      },
    },
  }
}

describe("the usage rollup task", () => {
  test("an already-aborted signal reports partial without touching the rollup", async () => {
    const rollup = recordingRollup(0)
    const task = createUsageRollupTask({
      usageDaily: rollup.usageDaily,
      scheduledTasks: { lastSuccess: async () => undefined },
      retention: { usageDays: 30 },
      intervalMs: 60_000,
    })
    const controller = new AbortController()
    controller.abort()

    const result = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })

    expect(result).toEqual({ outcome: "partial", itemsProcessed: 0 })
    expect(rollup.days).toEqual([])
  })

  test("a floor past `now` is a genuine no-op, not an empty scan", async () => {
    const rollup = recordingRollup(5)
    const task = createUsageRollupTask({
      usageDaily: rollup.usageDaily,
      scheduledTasks: { lastSuccess: async () => undefined },
      // usageDays: 0 pushes the floor to the start of *tomorrow*, past `now`.
      retention: { usageDays: 0 },
      intervalMs: 60_000,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(rollup.days).toEqual([])
  })

  test("a backfill is issued one bounded statement per day, never one across the window", async () => {
    const rollup = recordingRollup(2)
    const task = createUsageRollupTask({
      usageDaily: rollup.usageDaily,
      scheduledTasks: { lastSuccess: async () => undefined },
      retention: { usageDays: 30 },
      intervalMs: 60_000,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    // The floor is the start of the day after `now - 30d`, so the walk covers it
    // through today inclusive: 30 days, 30 statements, and the count is their sum.
    const floor = startOfNextUtcDay(new Date(NOW.getTime() - 30 * DAY_MS))
    expect(rollup.days).toHaveLength(30)
    expect(rollup.days[0]).toEqual(floor)
    expect(rollup.days.at(-1)).toEqual(startOfUtcDay(NOW))
    expect(result).toEqual({ outcome: "success", itemsProcessed: 60 })
  })

  test("a shutdown mid-backfill stops between days and reports partial", async () => {
    const controller = new AbortController()
    // Abort while the third day's statement is in flight: it finishes, the
    // fourth is never issued.
    const rollup = recordingRollup(2, (_day) => {
      if (rollup.days.length === 3) controller.abort()
    })
    const task = createUsageRollupTask({
      usageDaily: rollup.usageDaily,
      scheduledTasks: { lastSuccess: async () => undefined },
      retention: { usageDays: 30 },
      intervalMs: 60_000,
    })

    const result = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })

    expect(rollup.days).toHaveLength(3)
    expect(result).toEqual({ outcome: "partial", itemsProcessed: 6 })
  })

  test("the steady state re-closes yesterday and today, and recomputes rather than accumulates", async () => {
    const rollup = recordingRollup(42)
    const task = createUsageRollupTask({
      usageDaily: rollup.usageDaily,
      scheduledTasks: {
        lastSuccess: async () => successRun("usage_rollup", new Date(NOW.getTime() - 60_000)),
      },
      retention: { usageDays: 30 },
      intervalMs: 60_000,
    })

    const yesterday = new Date(startOfUtcDay(NOW).getTime() - DAY_MS)
    const first = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(rollup.days).toEqual([yesterday, startOfUtcDay(NOW)])
    expect(first).toEqual({ outcome: "success", itemsProcessed: 84 })

    // Same clock, same cursor: the window recomputes identically. `rollupDay`
    // replaces a day rather than adding to it, so a duplicate tick reports the
    // same total, never double it.
    const second = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(rollup.days).toEqual([yesterday, startOfUtcDay(NOW), yesterday, startOfUtcDay(NOW)])
    expect(second).toEqual(first)
  })
})
