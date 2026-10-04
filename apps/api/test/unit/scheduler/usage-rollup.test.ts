import { describe, expect, test } from "bun:test"
import { createUsageRollupTask } from "../../../src/scheduler"
import { silentLogger } from "./fixtures"

const NOW = new Date("2026-07-25T14:30:00Z")

describe("the usage history registration task", () => {
  test("an already aborted signal cannot begin a registration batch", async () => {
    let calls = 0
    const task = createUsageRollupTask({
      history: {
        backfill: async () => {
          calls += 1
          return { processed: 1, remaining: false }
        },
      },
      intervalMs: 60_000,
      batchSize: 2,
    })
    const controller = new AbortController()
    controller.abort()
    expect(await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })).toEqual(
      { outcome: "partial", itemsProcessed: 0 },
    )
    expect(calls).toBe(0)
  })

  test("drains bounded atomic registration batches and stops at a confirmed empty backlog", async () => {
    const limits: number[] = []
    const task = createUsageRollupTask({
      history: {
        backfill: async ({ limit }) => {
          limits.push(limit)
          return { processed: limits.length === 3 ? 0 : 2, remaining: limits.length < 3 }
        },
      },
      intervalMs: 60_000,
      batchSize: 2,
    })
    expect(
      await task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal }),
    ).toEqual({ outcome: "success", itemsProcessed: 4 })
    expect(limits).toEqual([2, 2, 2])
  })

  test("shutdown waits for the current batch but never begins another", async () => {
    const controller = new AbortController()
    let calls = 0
    const task = createUsageRollupTask({
      history: {
        backfill: async () => {
          calls += 1
          controller.abort()
          return { processed: 2, remaining: true }
        },
      },
      intervalMs: 60_000,
      batchSize: 2,
    })
    expect(await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })).toEqual(
      { outcome: "partial", itemsProcessed: 2 },
    )
    expect(calls).toBe(1)
  })

  test("a competing worker holding pending rows yields rather than spinning", async () => {
    let calls = 0
    const task = createUsageRollupTask({
      history: {
        backfill: async () => {
          calls += 1
          return { processed: 0, remaining: true }
        },
      },
      intervalMs: 60_000,
      batchSize: 2,
    })
    expect(
      await task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal }),
    ).toEqual({ outcome: "partial", itemsProcessed: 0 })
    expect(calls).toBe(1)
  })
})
