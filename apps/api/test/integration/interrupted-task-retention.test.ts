import { describe, expect, test } from "bun:test"
import {
  advisoryLockKey,
  createDatabase,
  createScheduledTaskRepository,
  createSchedulerLockPool,
} from "@multi-ai-router/db"
import { advisoryTaskLock } from "../../src/scheduler/lock"
import { createInterruptedRunMaintenance } from "../../src/scheduler/orphan-runs"

const url = process.env.DATABASE_URL ?? ""
describe.skipIf(!url)("historical task retention exclusion", () => {
  test("removed orphan becomes retention eligible while an independent boot retains its live run", async () => {
    const main = createDatabase({ url, maxConnections: 1 })
    const owner = createSchedulerLockPool({ url, maxConnections: 1, closeTimeoutSeconds: 0.1 })
    const maintenancePool = createSchedulerLockPool({
      url,
      maxConnections: 1,
      closeTimeoutSeconds: 0.1,
    })
    const repo = createScheduledTaskRepository(main.db)
    const ids: string[] = []
    const now = new Date()
    const old = new Date(now.getTime() - 100_000)
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const flight = owner.tryRun(
      advisoryLockKey("janitor_sweep"),
      new AbortController().signal,
      async () => {
        entered?.()
        await held
      },
    )
    try {
      await started
      const orphan = await repo.begin("usage_rollup", old)
      const live = await repo.begin("janitor_sweep", old)
      ids.push(orphan, live)
      await createInterruptedRunMaintenance({
        repo,
        lock: advisoryTaskLock(maintenancePool),
        cutoffAgeMs: 1_000,
        batchSize: 100,
        now: () => now,
      })(new AbortController().signal)
      const rows =
        await main.sql`select id,outcome,finished_at from scheduled_task_runs where id in (${orphan},${live})`
      expect(rows.find((row) => row.id === orphan)?.outcome).toBe("failed")
      expect(rows.find((row) => row.id === live)?.finished_at).toBeNull()
      // Retention can now delete the orphan; it still must preserve the live owner's unfinished row.
      await repo.deleteOlderThan(now, 10_000)
      const remaining =
        await main.sql`select id from scheduled_task_runs where id in (${orphan},${live})`
      expect(remaining.map((row) => row.id)).toEqual([live])
      release?.()
      await flight
      await createInterruptedRunMaintenance({
        repo,
        lock: advisoryTaskLock(maintenancePool),
        cutoffAgeMs: 1_000,
        batchSize: 100,
        now: () => now,
      })(new AbortController().signal)
      expect((await repo.lastRun("janitor_sweep"))?.outcome).toBe("failed")
    } finally {
      release?.()
      await flight
      await owner.close()
      await maintenancePool.close()
      for (const id of ids) await main.sql`delete from scheduled_task_runs where id=${id}`
      await main.close()
    }
  })
})
