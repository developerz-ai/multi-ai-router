import { describe, expect, test } from "bun:test"
import type { RetentionConfig } from "../../../src/config/env"
import type { TaskOutcome } from "../../../src/scheduler"
import { createJanitorTask } from "../../../src/scheduler"
import { ageBucket, NOW, silentLogger } from "./fixtures"

/**
 * `createJanitorTask` is `runSweeps` (`sweep.ts`) plumbed to four categories.
 * These tests exercise it end to end with in-memory `AgeBucket`s standing in
 * for the four repositories, rather than re-testing `runSweeps` in isolation —
 * the contract that matters is the whole task's, not the loop's.
 */

const RETENTION: RetentionConfig = {
  sessionsHours: 1,
  usageDays: 1,
  auditDays: 1,
  revokedKeysDays: 1,
  oauthStateMinutes: 10,
}

/** Older than every cutoff `RETENTION` computes off `NOW`. */
const OLD = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)

type Report = TaskOutcome & { readonly counts: Record<string, number> }

describe("the janitor sweep", () => {
  test("drains every category in one tick, and a second tick is a no-op", async () => {
    const sessions = ageBucket([OLD, OLD, OLD])
    const usageRecords = ageBucket([OLD, OLD])
    const auditEvents = ageBucket([OLD])
    const apiKeys = ageBucket([])

    const task = createJanitorTask({
      sessions: { deleteIdleBefore: sessions.deleteBatch },
      usageRecords: { deleteOlderThan: usageRecords.deleteBatch },
      auditEvents: { deleteOlderThan: auditEvents.deleteBatch },
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
    expect(first.itemsProcessed).toBe(6)
    expect((first as Report).counts).toEqual({
      sessions: 3,
      usageRecords: 2,
      auditEvents: 1,
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
      auditEvents: 0,
      revokedKeys: 0,
    })
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
      auditEvents: { deleteOlderThan: empty.deleteBatch },
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
