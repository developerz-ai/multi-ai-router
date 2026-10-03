import { describe, expect, test } from "bun:test"
import { advisoryLockKey, createDatabase, createSchedulerLockPool } from "@multi-ai-router/db"
import { createScheduler } from "../../src/scheduler/runner"
import { memoryTaskRepository, silentLogger } from "../unit/scheduler/fixtures"

const url = process.env.DATABASE_URL ?? ""
describe.skipIf(!url)("scheduler local capacity retry with actual PostgreSQL", () => {
  test("pool1 retries a second due six-hour task promptly instead of waiting its full interval", async () => {
    const main = createDatabase({ url, maxConnections: 1 })
    const pool = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const capacity = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const salt = Math.floor(Math.random() * 0x7fff_ffff)
    let firstCalls = 0,
      secondCalls = 0,
      localSkips = 0,
      remoteSkips = 0
    const scheduler = createScheduler({
      repo: memoryTaskRepository(),
      logger: silentLogger(),
      jitterFraction: 0,
      // Unique scratch keys avoid interacting with any other fixture's task sessions.
      lock: (key, work, signal = new AbortController().signal) =>
        pool.tryRun(key ^ salt, signal, work),
      capacityRetryMs: 10,
      shutdownDrainMs: 100,
      onTick: (tick) => {
        if (tick.status === "skipped_capacity") {
          localSkips++
          capacity.resolve()
        }
        if (tick.status === "skipped_locked") remoteSkips++
        if (tick.task === "admin_session_purge" && tick.status === "success") finished.resolve()
      },
      tasks: [
        {
          name: "janitor_sweep",
          intervalMs: 6 * 60 * 60 * 1000,
          startupDelayMs: 1,
          run: async () => {
            firstCalls++
            entered.resolve()
            await release.promise
            expect((await main.sql`select 1 as answer`)[0]?.answer).toBe(1)
            return { outcome: "success", itemsProcessed: 1 }
          },
        },
        {
          name: "admin_session_purge",
          intervalMs: 6 * 60 * 60 * 1000,
          startupDelayMs: 2,
          run: async () => {
            secondCalls++
            expect((await main.sql`select 2 as answer`)[0]?.answer).toBe(2)
            return { outcome: "success", itemsProcessed: 1 }
          },
        },
      ],
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      scheduler.start()
      await Promise.all([entered.promise, capacity.promise])
      expect(secondCalls).toBe(0)
      const at = Date.now()
      release.resolve()
      await Promise.race([
        finished.promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("local capacity task was stranded")), 500)
        }),
      ])
      expect(Date.now() - at).toBeLessThan(500)
      expect(firstCalls).toBe(1)
      expect(secondCalls).toBe(1)
      expect(localSkips).toBeGreaterThanOrEqual(1)
      expect(remoteSkips).toBe(0)
      expect(pool.poolStats().inUse).toBe(0)
    } finally {
      clearTimeout(deadline)
      release.resolve()
      await scheduler.stop()
      await pool.close()
      await main.close()
    }
  })
  test("remote advisory contention keeps the normal interval rather than local capacity retry", async () => {
    const owner = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.1 })
    const contender = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.1 })
    const salt = Math.floor(Math.random() * 0x7fff_ffff)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const skipped = Promise.withResolvers<void>()
    let runs = 0,
      skips = 0
    const running = owner.tryRun(
      advisoryLockKey("janitor_sweep") ^ salt,
      new AbortController().signal,
      async () => {
        entered.resolve()
        await release.promise
      },
    )
    const scheduler = createScheduler({
      repo: memoryTaskRepository(),
      logger: silentLogger(),
      jitterFraction: 0,
      lock: (key, work, signal = new AbortController().signal) =>
        contender.tryRun(key ^ salt, signal, work),
      capacityRetryMs: 10,
      shutdownDrainMs: 100,
      onTick: (tick) => {
        if (tick.status === "skipped_locked") {
          skips++
          skipped.resolve()
        }
      },
      tasks: [
        {
          name: "janitor_sweep",
          intervalMs: 6 * 60 * 60 * 1000,
          startupDelayMs: 1,
          run: async () => {
            runs++
            return { outcome: "success", itemsProcessed: 1 }
          },
        },
      ],
    })
    try {
      await entered.promise
      scheduler.start()
      await skipped.promise
      release.resolve()
      await running
      await Bun.sleep(50)
      expect(runs).toBe(0)
      expect(skips).toBe(1)
      expect(contender.poolStats().inUse).toBe(0)
    } finally {
      release.resolve()
      await scheduler.stop()
      await running
      await Promise.all([owner.close(), contender.close()])
    }
  })
})
