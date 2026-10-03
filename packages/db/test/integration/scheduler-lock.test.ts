import { describe, expect, test } from "bun:test"
import { advisoryLockKey } from "../../src/advisory-lock"
import { createDatabase } from "../../src/client"
import { createCredentialRefreshLockPool } from "../../src/credential-refresh-lock"
import { createScheduledTaskRepository } from "../../src/repositories/scheduled-task-repository"
import { createSchedulerLockPool } from "../../src/scheduler-lock"

const url = process.env.DATABASE_URL ?? ""
describe.skipIf(!url)("dedicated scheduler advisory session", () => {
  test("main pool max1 remains available for the complete scheduled task run", async () => {
    const main = createDatabase({ url, maxConnections: 1 })
    const lock = createSchedulerLockPool({
      url,
      maxConnections: 1,
      connectTimeoutSeconds: 1,
      closeTimeoutSeconds: 0.1,
    })
    let id: string | undefined
    try {
      const outcome = await lock.tryRun(
        advisoryLockKey(crypto.randomUUID()),
        new AbortController().signal,
        async () => {
          const repo = createScheduledTaskRepository(main.db)
          id = await repo.begin("janitor_sweep", new Date())
          expect((await main.sql`select 1 as count`)[0]?.count).toBe(1)
          await repo.finish(id, { outcome: "success", itemsProcessed: 1 }, new Date())
          return 1
        },
      )
      expect(outcome).toMatchObject({ acquired: true, value: 1 })
    } finally {
      await lock.close()
      if (id) await main.sql`delete from scheduled_task_runs where id=${id}`
      await main.close()
    }
  })
  test("task exclusion is fleet-wide and independent of refresh pool capacity and namespace", async () => {
    const first = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.1 })
    const second = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.1 })
    const refresh = createCredentialRefreshLockPool({
      url,
      maxConnections: 1,
      closeTimeoutSeconds: 0.1,
    })
    const name = crypto.randomUUID()
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    try {
      const running = first.tryRun(
        advisoryLockKey(name),
        new AbortController().signal,
        async () => {
          entered?.()
          await held
          return 1
        },
      )
      await started
      expect(
        (await second.tryRun(advisoryLockKey(name), new AbortController().signal, async () => 2))
          .acquired,
      ).toBe(false)
      expect(
        (await refresh.tryRun(name, new AbortController().signal, async () => 3)).acquired,
      ).toBe(true)
      release?.()
      await running
      expect(
        (await second.tryRun(advisoryLockKey(name), new AbortController().signal, async () => 4))
          .acquired,
      ).toBe(true)
    } finally {
      release?.()
      await Promise.all([first.close(), second.close(), refresh.close()])
    }
  })
  test("close aborts an uncooperative task and releases its session within the configured budget", async () => {
    const first = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.03 })
    const second = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.03 })
    const key = advisoryLockKey(crypto.randomUUID())
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let aborted = false
    try {
      void first.tryRun(key, new AbortController().signal, async (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        entered?.()
        await new Promise(() => {})
      })
      await started
      const at = Date.now()
      await first.close()
      expect(Date.now() - at).toBeLessThan(500)
      expect(aborted).toBe(true)
      expect((await second.tryRun(key, new AbortController().signal, async () => 1)).acquired).toBe(
        true,
      )
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })
})
