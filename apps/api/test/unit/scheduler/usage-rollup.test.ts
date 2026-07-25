import { describe, expect, test } from "bun:test"
import { startOfNextUtcDay, startOfUtcDay } from "@multi-ai-router/db"
import type { RetentionConfig } from "../../../src/config/env"
import { createUsageRollupTask, rollupFrom } from "../../../src/scheduler"
import { silentLogger } from "./fixtures"

/**
 * `rollupFrom` is tested directly first — it is a pure function of a clock and
 * a row, exactly the "no mocks, inject the snapshot" shape the house style
 * asks for. `createUsageRollupTask` is then tested for the two things that
 * are not about window arithmetic: the abort-before-work `partial`, and the
 * from >= now `success, itemsProcessed: 0` no-op.
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

describe("the usage rollup task", () => {
  test("an already-aborted signal reports partial without touching the rollup", async () => {
    let called = 0
    const task = createUsageRollupTask({
      usageDaily: {
        rollup: async () => {
          called += 1
          return 0
        },
      },
      scheduledTasks: { lastSuccess: async () => undefined },
      retention: { usageDays: 30 },
      intervalMs: 60_000,
    })
    const controller = new AbortController()
    controller.abort()

    const result = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })

    expect(result).toEqual({ outcome: "partial", itemsProcessed: 0 })
    expect(called).toBe(0)
  })

  test("a floor past `now` is a genuine no-op, not an empty scan", async () => {
    let called = 0
    const task = createUsageRollupTask({
      usageDaily: {
        rollup: async () => {
          called += 1
          return 5
        },
      },
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
    expect(called).toBe(0)
  })

  test("rolls the computed window, and re-running it recomputes rather than accumulates", async () => {
    const calls: Array<{ from: Date; to: Date }> = []
    const task = createUsageRollupTask({
      usageDaily: {
        rollup: async (from, to) => {
          calls.push({ from, to })
          return 42
        },
      },
      scheduledTasks: { lastSuccess: async () => undefined },
      retention: { usageDays: 30 },
      intervalMs: 60_000,
    })

    const first = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(first).toEqual({ outcome: "success", itemsProcessed: 42 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.to).toEqual(NOW)

    // Same clock, no new success recorded in between: the window recomputes
    // identically. `usageDaily.rollup` replaces a day rather than adding to
    // it, so a duplicate tick reports the same total, never double it.
    const second = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(second).toEqual({ outcome: "success", itemsProcessed: 42 })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
  })
})
