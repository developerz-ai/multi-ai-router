import { describe, expect, test } from "bun:test"
import { createAdminSessionPurgeTask } from "../../../src/scheduler/tasks/admin-session-purge"
import { NOW, silentLogger } from "./fixtures"

/**
 * `createAdminSessionPurgeTask` is the scheduler's own thin wrapper over
 * `SessionStore.deleteExpired` — see the task's module comment for why it is
 * not folded into the janitor (a `Map` in this process's heap, not a table).
 */

describe("the admin session purge", () => {
  test("clears whatever the store reports, against the tick's own clock", async () => {
    let seenNowMs: number | undefined
    const task = createAdminSessionPurgeTask({
      sessions: {
        deleteExpired: (nowMs) => {
          seenNowMs = nowMs
          return Promise.resolve(3)
        },
      },
      intervalMs: 60_000,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(3)
    expect(seenNowMs).toBe(NOW.getTime())
  })

  test("nothing expired is a no-op, not a failure", async () => {
    const task = createAdminSessionPurgeTask({
      sessions: { deleteExpired: () => Promise.resolve(0) },
      intervalMs: 60_000,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(0)
  })

  test("carries the `admin_session_purge` name the `scheduled_task` enum expects", () => {
    const task = createAdminSessionPurgeTask({
      sessions: { deleteExpired: () => Promise.resolve(0) },
      intervalMs: 60_000,
    })

    expect(task.name).toBe("admin_session_purge")
    expect(task.intervalMs).toBe(60_000)
  })
})
