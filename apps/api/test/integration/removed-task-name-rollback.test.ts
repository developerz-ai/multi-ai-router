import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createDatabase,
  createScheduledTaskRepository,
  createSchedulerLockPool,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createLogger } from "../../src/logging/logger"
import { advisoryTaskLock, createScheduler } from "../../src/scheduler"
import { createInterruptedRunMaintenance } from "../../src/scheduler/orphan-runs"
import { createSettingsService } from "../../src/services/settings"
import {
  INTERVALS,
  memoryAuditLog,
  memoryPrices,
  RETENTION,
  recordingAudit,
} from "../unit/settings/fixtures"

/**
 * Rollback guard, against a real PostgreSQL: a newer release may have written
 * `scheduled_task_runs` rows under a task name this build's enum no longer has.
 * Rolling back must not throw on the settings read, on the scheduler's
 * last-run lookup, or in the orphan sweep, and the sweep must still close the
 * unfinished row. Only the sweep can actually read the foreign row: the settings
 * read and the last-run lookup query by current task names, so those two legs
 * pin that read shape rather than guard it. Own database, dropped afterwards,
 * because the enum value added here can never be removed again.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""
const databaseName = `removed_task_${crypto.randomUUID().replaceAll("-", "")}`

let admin: DatabaseHandle | undefined
let handle: DatabaseHandle | undefined
let ownUrl = ""

beforeAll(async () => {
  if (!runnable) return
  admin = createDatabase({ url, maxConnections: 1 })
  await admin.sql.unsafe(`create database "${databaseName}"`)
  const uri = new URL(url)
  uri.pathname = `/${databaseName}`
  ownUrl = uri.toString()
  await runMigrations({ url: ownUrl, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url: ownUrl, maxConnections: 2 })
}, 60_000)

afterAll(async () => {
  await handle?.close()
  await admin?.sql.unsafe(`drop database if exists "${databaseName}" with (force)`)
  await admin?.close()
}, 30_000)

describe.skipIf(!runnable)("a scheduled_task enum value this build does not know", () => {
  test("settings, the runner's last-run lookup and the orphan sweep all survive it", async () => {
    if (handle === undefined) throw new Error("unreachable: describe.skipIf gates this")
    const { db, sql } = handle
    // Outside a transaction (ALTER TYPE ... ADD VALUE), on this test's own database only.
    await sql.unsafe(`alter type scheduled_task add value 'removed_task_name'`)
    const started = new Date(Date.now() - 3_600_000)
    const inserted = await sql.unsafe(
      `insert into scheduled_task_runs (task, started_at) values ('removed_task_name', $1) returning id`,
      [started.toISOString()],
    )
    const removedId = String(inserted[0]?.id)
    const repo = createScheduledTaskRepository(db)

    // 1. Settings tasks() read, over the real repository.
    const settings = createSettingsService({
      prices: memoryPrices(),
      scheduledTasks: repo,
      auditEvents: memoryAuditLog([]),
      audit: recordingAudit(),
      env: {
        retention: RETENTION,
        logLevel: "warn",
        janitorIntervalMinutes: 42,
        publicUrl: null,
      },
      intervals: INTERVALS,
      now: () => new Date(),
    })
    const tasks = await settings.tasks()
    expect(tasks.ok).toBe(true)

    // 2. The runner's lastRun path: a lookup failure would be logged at warn.
    const lines: string[] = []
    const logger = createLogger({ level: "warn", write: (line) => void lines.push(String(line)) })
    const pool = createSchedulerLockPool({
      url: ownUrl,
      maxConnections: 1,
      closeTimeoutSeconds: 0.1,
    })
    const ran = Promise.withResolvers<void>()
    const scheduler = createScheduler({
      repo,
      logger,
      jitterFraction: 0,
      lock: advisoryTaskLock(pool),
      shutdownDrainMs: 100,
      onTick: (tick) => {
        if (tick.status === "success") ran.resolve()
      },
      tasks: [
        {
          name: "janitor_sweep",
          intervalMs: 3_600_000,
          startupDelayMs: 1,
          run: async () => ({ outcome: "success", itemsProcessed: 0 }),
        },
      ],
    })
    try {
      scheduler.start()
      await ran.promise
      expect(lines.filter((line) => line.includes("last-run lookup failed"))).toEqual([])
      expect(await repo.lastRun("janitor_sweep")).toBeDefined()

      // 3. The orphan sweep closes the removed task's unfinished row without throwing.
      await createInterruptedRunMaintenance({
        repo,
        lock: advisoryTaskLock(pool),
        cutoffAgeMs: 1_000,
        batchSize: 100,
      })(new AbortController().signal)
      const rows = await sql.unsafe(
        `select outcome, finished_at from scheduled_task_runs where id = $1`,
        [removedId],
      )
      expect(rows[0]?.outcome).toBe("failed")
      expect(rows[0]?.finished_at).not.toBeNull()
    } finally {
      await scheduler.stop()
      await pool.close()
    }
  }, 30_000)
})
