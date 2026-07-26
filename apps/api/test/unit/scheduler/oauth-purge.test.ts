import { describe, expect, test } from "bun:test"
import { createOauthPurgeTask } from "../../../src/scheduler/tasks/oauth-purge"
import { ageBucket, NOW, silentLogger } from "./fixtures"

/**
 * `createOauthPurgeTask` is `runSweeps` (`sweep.ts`) plumbed to the single
 * `oauthStates` category, on its own cadence and batch size — separate from
 * the janitor because the rows carry an AES-256-GCM envelope of a
 * `code_verifier` and must not sit expired any longer than a tick.
 */

/** Older than `NOW`, i.e. already past `expires_at`. */
const EXPIRED = new Date(NOW.getTime() - 60_000)

describe("the OAuth state purge", () => {
  test("drains every expired row in one tick, and a second tick is a no-op", async () => {
    const oauthStates = ageBucket([EXPIRED, EXPIRED, EXPIRED])

    const task = createOauthPurgeTask({
      oauthStates: {
        deleteExpiredBefore: (cutoff, limit) => oauthStates.deleteBatch(cutoff, limit),
      },
      intervalMs: 60_000,
      batchSize: 2,
    })

    const first = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(first.outcome).toBe("success")
    expect(first.itemsProcessed).toBe(3)
    expect(oauthStates.remaining()).toBe(0)

    const second = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(second.outcome).toBe("success")
    expect(second.itemsProcessed).toBe(0)
  })

  test("the cutoff passed is the tick's own clock, not shifted by the caller", async () => {
    let seenCutoff: Date | undefined
    const oauthStates = ageBucket([EXPIRED])

    const task = createOauthPurgeTask({
      oauthStates: {
        deleteExpiredBefore: (cutoff, limit) => {
          seenCutoff = cutoff
          return oauthStates.deleteBatch(cutoff, limit)
        },
      },
      intervalMs: 60_000,
      batchSize: 100,
    })

    await task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal })

    expect(seenCutoff).toEqual(NOW)
  })

  test("a shutdown mid-drain reports partial, and the next tick finishes it", async () => {
    // Five expired rows against a batch size of two: the drain needs three
    // batches, and shutdown lands right after the first one commits.
    const oauthStates = ageBucket([EXPIRED, EXPIRED, EXPIRED, EXPIRED, EXPIRED])
    let calls = 0
    const controller = new AbortController()

    const task = createOauthPurgeTask({
      oauthStates: {
        deleteExpiredBefore: async (cutoff, limit) => {
          calls += 1
          const removed = await oauthStates.deleteBatch(cutoff, limit)
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
    expect(oauthStates.remaining()).toBe(3)

    const resume = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(resume.outcome).toBe("success")
    expect(resume.itemsProcessed).toBe(3)
    expect(oauthStates.remaining()).toBe(0)
  })

  test("a row not yet past expires_at is left alone", async () => {
    const notYetExpired = new Date(NOW.getTime() + 60_000)
    const oauthStates = ageBucket([notYetExpired])

    const task = createOauthPurgeTask({
      oauthStates: {
        deleteExpiredBefore: (cutoff, limit) => oauthStates.deleteBatch(cutoff, limit),
      },
      intervalMs: 60_000,
      batchSize: 100,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })
    expect(result.itemsProcessed).toBe(0)
    expect(oauthStates.remaining()).toBe(1)
  })
})
