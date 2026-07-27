import { describe, expect, test } from "bun:test"
import type { RetentionConfig } from "../../../src/config/env"
import type { TaskOutcome } from "../../../src/scheduler"
import { createJanitorTask } from "../../../src/scheduler"
import { ageBucket, NOW, silentLogger } from "./fixtures"

/**
 * `createJanitorTask` is `runSweeps` (`sweep.ts`) plumbed to six categories.
 * These tests exercise it end to end with in-memory `AgeBucket`s standing in
 * for the six repositories, rather than re-testing `runSweeps` in isolation —
 * the contract that matters is the whole task's, not the loop's.
 */

const RETENTION: RetentionConfig = {
  sessionsHours: 1,
  usageDays: 1,
  usageDailyDays: 1,
  auditDays: 1,
  taskRunsDays: 1,
  revokedKeysDays: 1,
  oauthStateMinutes: 10,
  orphanConfigDirHours: 1,
}

/** Older than every cutoff `RETENTION` computes off `NOW`. */
const OLD = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)

type Report = TaskOutcome & { readonly counts: Record<string, number> }

describe("the janitor sweep", () => {
  test("drains every category in one tick, and a second tick is a no-op", async () => {
    const sessions = ageBucket([OLD, OLD, OLD])
    const usageRecords = ageBucket([OLD, OLD])
    const usageDaily = ageBucket([OLD, OLD, OLD, OLD])
    const auditEvents = ageBucket([OLD])
    const taskRuns = ageBucket([OLD, OLD, OLD])
    const apiKeys = ageBucket([])

    const task = createJanitorTask({
      sessions: { deleteIdleBefore: sessions.deleteBatch },
      usageRecords: { deleteOlderThan: usageRecords.deleteBatch },
      usageDaily: { deleteOlderThan: usageDaily.deleteBatch },
      auditEvents: { deleteOlderThan: auditEvents.deleteBatch },
      taskRuns: { deleteOlderThan: taskRuns.deleteBatch },
      apiKeys: { deleteRevokedOlderThan: apiKeys.deleteBatch },
      retention: RETENTION,
      intervalMs: 60_000,
      batchSize: 2,
    })

    const first = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(first.outcome).toBe("success")
    expect(first.itemsProcessed).toBe(13)
    // Every one of the six tables that grows without bound is named, including
    // the two that are only aggregates and bookkeeping — nothing is left off.
    expect((first as Report).counts).toEqual({
      sessions: 3,
      usageRecords: 2,
      usageDaily: 4,
      auditEvents: 1,
      taskRuns: 3,
      revokedKeys: 0,
    })

    const second = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(second.outcome).toBe("success")
    expect(second.itemsProcessed).toBe(0)
    expect((second as Report).counts).toEqual({
      sessions: 0,
      usageRecords: 0,
      usageDaily: 0,
      auditEvents: 0,
      taskRuns: 0,
      revokedKeys: 0,
    })
  })

  test("each category is measured against its own window, off one clock", async () => {
    // Daily aggregates outlive raw rows by design, and run rows outlive neither:
    // three different windows, one `now`, so a row is judged by the window that
    // names it and not by whichever sweep happens to run first.
    const cutoffs: Record<string, Date> = {}
    const record =
      (category: string) =>
      async (cutoff: Date, _limit: number): Promise<number> => {
        cutoffs[category] = cutoff
        return 0
      }

    const task = createJanitorTask({
      sessions: { deleteIdleBefore: record("sessions") },
      usageRecords: { deleteOlderThan: record("usageRecords") },
      usageDaily: { deleteOlderThan: record("usageDaily") },
      auditEvents: { deleteOlderThan: record("auditEvents") },
      taskRuns: { deleteOlderThan: record("taskRuns") },
      apiKeys: { deleteRevokedOlderThan: record("revokedKeys") },
      retention: { ...RETENTION, usageDays: 90, usageDailyDays: 730, taskRunsDays: 30 },
      intervalMs: 60_000,
      batchSize: 2,
    })

    await task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal })

    const daysBack = (category: string): number =>
      Math.round((NOW.getTime() - (cutoffs[category]?.getTime() ?? 0)) / (24 * 60 * 60 * 1000))
    expect(daysBack("usageRecords")).toBe(90)
    expect(daysBack("usageDaily")).toBe(730)
    expect(daysBack("taskRuns")).toBe(30)
  })

  test("a shutdown mid-drain reports partial, and the next tick finishes it", async () => {
    // Five old rows against a batch size of two: the drain needs three
    // batches, and shutdown lands right after the first one commits.
    const sessions = ageBucket([OLD, OLD, OLD, OLD, OLD])
    const empty = ageBucket([])
    let calls = 0
    const controller = new AbortController()

    const task = createJanitorTask({
      sessions: {
        deleteIdleBefore: async (cutoff, limit) => {
          calls += 1
          const removed = await sessions.deleteBatch(cutoff, limit)
          if (calls === 1) controller.abort()
          return removed
        },
      },
      usageRecords: { deleteOlderThan: empty.deleteBatch },
      usageDaily: { deleteOlderThan: empty.deleteBatch },
      auditEvents: { deleteOlderThan: empty.deleteBatch },
      taskRuns: { deleteOlderThan: empty.deleteBatch },
      apiKeys: { deleteRevokedOlderThan: empty.deleteBatch },
      retention: RETENTION,
      intervalMs: 60_000,
      batchSize: 2,
    })

    const partial = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })
    expect(partial.outcome).toBe("partial")
    expect(partial.itemsProcessed).toBe(2)
    expect(sessions.remaining()).toBe(3)

    const resume = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(resume.outcome).toBe("success")
    expect(resume.itemsProcessed).toBe(3)
    expect(sessions.remaining()).toBe(0)

    const noop = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(noop.outcome).toBe("success")
    expect(noop.itemsProcessed).toBe(0)
  })
})
