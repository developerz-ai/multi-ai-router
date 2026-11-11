import { describe, expect, test } from "bun:test"
import type { DatabaseHandle } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createDatabaseProbe } from "../../../src/services/health/databaseProbe"

const silent = createLogger({ level: "error", write: () => {} })

/** A `sql` tag whose every query hangs until cancelled, counting both. */
function wedged() {
  const counts = { queries: 0, cancels: 0 }
  const sql = (() => {
    counts.queries++
    let reject: (error: Error) => void = () => {}
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail
    })
    return Object.assign(pending, {
      cancel: () => {
        counts.cancels++
        reject(new Error("cancelled"))
      },
    })
  }) as unknown as DatabaseHandle["sql"]
  return { handle: { sql }, counts }
}

// Plan 101, 03.10: a timed-out `select 1` stayed queued on the pool requests share.
describe("createDatabaseProbe against a wedged database", () => {
  test("a timed-out probe cancels its query once and reports false", async () => {
    const { handle, counts } = wedged()
    const probe = createDatabaseProbe({ handle, log: silent, timeoutMs: 10 })
    expect(await probe()).toBe(false)
    expect(counts).toEqual({ queries: 1, cancels: 1 })
  })

  test("concurrent polls share one query", async () => {
    const { handle, counts } = wedged()
    const probe = createDatabaseProbe({ handle, log: silent, timeoutMs: 10 })
    const results = await Promise.all([probe(), probe(), probe()])
    expect(results).toEqual([false, false, false])
    expect(counts.queries).toBe(1)
    expect(await probe()).toBe(false)
    expect(counts.queries).toBe(2)
  })
})
