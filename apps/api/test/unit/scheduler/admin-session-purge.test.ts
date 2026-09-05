import { describe, expect, test } from "bun:test"
import { createAdminSessionPurgeTask } from "../../../src/scheduler/tasks/admin-session-purge"
import { NOW, silentLogger } from "./fixtures"

/**
 * `createAdminSessionPurgeTask` is `runSweeps` (`sweep.ts`) plumbed to the
 * single `adminSessions` category over the store's bounded `deleteExpired`,
 * on its own cadence and the shared batch size.
 */

/** A store double: `count` expired sessions, drained `limit` at a time. */
function expiredSessions(count: number) {
  let remaining = count
  const seen: Array<{ nowMs: number; limit: number }> = []
  return {
    seen,
    remaining: () => remaining,
    deleteExpired: async (nowMs: number, limit: number) => {
      seen.push({ nowMs, limit })
      const batch = Math.min(remaining, limit)
      remaining -= batch
      return batch
    },
  }
}

describe("the admin session purge", () => {
  test("drains every expired session in one tick against the tick's own clock, in batches", async () => {
    const sessions = expiredSessions(5)
    const task = createAdminSessionPurgeTask({ sessions, intervalMs: 60_000, batchSize: 2 })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(5)
    expect(sessions.remaining()).toBe(0)
    // Three batches: 2, 2, 1 — the short one ends the drain.
    expect(sessions.seen).toEqual([
      { nowMs: NOW.getTime(), limit: 2 },
      { nowMs: NOW.getTime(), limit: 2 },
      { nowMs: NOW.getTime(), limit: 2 },
    ])
  })

  test("nothing expired is a no-op, not a failure", async () => {
    const task = createAdminSessionPurgeTask({
      sessions: expiredSessions(0),
      intervalMs: 60_000,
      batchSize: 100,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(0)
  })

  test("a shutdown mid-drain reports partial, and the next tick finishes it", async () => {
    const sessions = expiredSessions(5)
    const controller = new AbortController()
    let calls = 0
    const task = createAdminSessionPurgeTask({
      sessions: {
        deleteExpired: async (nowMs, limit) => {
          calls += 1
          const removed = await sessions.deleteExpired(nowMs, limit)
          if (calls === 1) controller.abort()
          return removed
        },
      },
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
  })

  test("carries the `admin_session_purge` name the `scheduled_task` enum expects", () => {
    const task = createAdminSessionPurgeTask({
      sessions: expiredSessions(0),
      intervalMs: 60_000,
      batchSize: 100,
    })

    expect(task.name).toBe("admin_session_purge")
    expect(task.intervalMs).toBe(60_000)
  })
})
