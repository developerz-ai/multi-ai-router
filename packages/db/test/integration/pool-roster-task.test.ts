import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createScheduledTaskRepository } from "../../src/repositories/scheduled-task-repository"
import { scheduledTask, scheduledTaskOutcome } from "../../src/schema/enums"
import type { ScheduledTaskRunRow } from "../../src/schema/scheduled-task-runs"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

const fresh = ownDatabaseFixture("pool_roster_task")
const startedAt = new Date("2026-11-19T12:00:00Z")

async function enumValues(handle: DatabaseHandle): Promise<string[]> {
  const rows = await handle.sql<{ value: string }[]>`
    select enumlabel as value from pg_enum
    where enumtypid = 'public.scheduled_task'::regtype order by enumsortorder`
  return rows.map((row) => row.value)
}

async function replay(handle: DatabaseHandle, url: string): Promise<void> {
  await runMigrations({ url })
  await runMigrations({ url })
  const sql = await Bun.file(
    new URL("../../migrations/0051_pool_roster_check.sql", import.meta.url),
  ).text()
  await handle.sql.unsafe(sql)
  await handle.sql.unsafe(sql)
  expect(await enumValues(handle)).toEqual(scheduledTask.enumValues)
}

async function roundTrip(handle: DatabaseHandle): Promise<void> {
  const repository = createScheduledTaskRepository(handle.db)
  for (const task of scheduledTask.enumValues) {
    let success: ScheduledTaskRunRow | undefined
    for (const [index, outcome] of scheduledTaskOutcome.enumValues.entries()) {
      const start = new Date(startedAt.getTime() + index * 60_000)
      const finish = new Date(start.getTime() + 1_000)
      const id = await repository.begin(task, start)
      expect(await repository.lastRun(task)).toEqual({
        id,
        task,
        startedAt: start,
        finishedAt: null,
        outcome: null,
        itemsProcessed: 0,
        error: null,
      })
      const error = outcome === "failed" ? "fixture failure" : null
      const row = await repository.finish(id, { outcome, itemsProcessed: index + 1, error }, finish)
      expect(row).toEqual({
        id,
        task,
        startedAt: start,
        finishedAt: finish,
        outcome,
        itemsProcessed: index + 1,
        error,
      })
      if (outcome === "success") success = row
      expect(await repository.lastRun(task)).toEqual(row)
      expect(await repository.lastSuccess(task)).toEqual(success)
      const latest = await repository.latestPerTask()
      expect(latest.lastRun.get(task)).toEqual(row)
      expect(latest.lastSuccess.get(task)).toEqual(success)
    }
  }
}

async function folderThrough50(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "mar-pool-roster-"))
  try {
    await cp(defaultMigrationsFolder(), folder, { recursive: true })
    const path = join(folder, "meta", "_journal.json")
    const journal = (await Bun.file(path).json()) as { entries: { idx: number }[] }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 50)
    await writeFile(path, JSON.stringify(journal))
    return folder
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
}

describe.skipIf(ownDatabaseUrl === "")("pool roster task persistence", () => {
  test("fresh migration, every task/outcome round-trip, and replay preserve rows", async () => {
    expect(await enumValues(fresh.get())).toEqual(scheduledTask.enumValues)
    await roundTrip(fresh.get())
    const before = await fresh.sql()`select * from scheduled_task_runs order by id`
    await replay(fresh.get(), fresh.url())
    expect(await fresh.sql()`select * from scheduled_task_runs order by id`).toEqual(before)
  }, 60_000)

  test("upgrade from 0050 appends the enum and preserves existing runs across replay", async () => {
    const admin = createDatabase({ url: ownDatabaseUrl, maxConnections: 1 })
    const name = `roster_upgrade_${crypto.randomUUID().replaceAll("-", "")}`
    const uri = new URL(ownDatabaseUrl)
    uri.pathname = `/${name}`
    const url = uri.toString()
    let beforeFolder: string | undefined
    try {
      beforeFolder = await folderThrough50()
      await admin.sql.unsafe(`create database "${name}"`)
      await runMigrations({ url, migrationsFolder: beforeFolder })
      const handle = createDatabase({ url, maxConnections: 1 })
      try {
        const oldNames = scheduledTask.enumValues.filter((task) => task !== "pool_roster_check")
        expect(await enumValues(handle)).toEqual(oldNames)
        const repository = createScheduledTaskRepository(handle.db)
        for (const task of oldNames) {
          const id = await repository.begin(task, new Date("2026-11-18T12:00:00Z"))
          await repository.finish(id, { outcome: "success", itemsProcessed: 42 }, startedAt)
        }
        const before = await handle.sql`select * from scheduled_task_runs order by id`
        await replay(handle, url)
        expect(await handle.sql`select * from scheduled_task_runs order by id`).toEqual(before)
        await roundTrip(handle)
        const after = await handle.sql`select * from scheduled_task_runs order by id`
        await replay(handle, url)
        expect(await handle.sql`select * from scheduled_task_runs order by id`).toEqual(after)
      } finally {
        await handle.close()
      }
    } finally {
      try {
        await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
      } finally {
        await admin.close()
        if (beforeFolder !== undefined) await rm(beforeFolder, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
