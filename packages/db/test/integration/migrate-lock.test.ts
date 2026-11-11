import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDatabase } from "../../src/client"
import {
  defaultMigrationsFolder,
  MIGRATION_LOCK_ID,
  MigrationLockTimeoutError,
  runMigrations,
} from "../../src/migrate"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * A pending DDL stuck behind a long read used to wait forever — and every later query on that
 * table queued behind it. With the bound, the boot fails naming why, and a replica that merely
 * waits its turn on the migration advisory lock is told so instead of hanging silently.
 */
const fixture = ownDatabaseFixture("migrate_lock")

/** The shipped migrations plus one pending file that needs ACCESS EXCLUSIVE on `accounts`. */
async function folderWithPendingAlter(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "mar-migrate-lock-"))
  await cp(defaultMigrationsFolder(), folder, { recursive: true })
  const journalPath = join(folder, "meta", "_journal.json")
  const journal = (await Bun.file(journalPath).json()) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }
  const last = journal.entries.at(-1)
  if (last === undefined) throw new Error("empty journal")
  const tag = `${String(last.idx + 1).padStart(4, "0")}_lock_probe`
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag })
  await writeFile(journalPath, JSON.stringify(journal))
  await writeFile(
    join(folder, `${tag}.sql`),
    `ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "lock_probe" integer;`,
  )
  return folder
}

describe.skipIf(ownDatabaseUrl === "")("runMigrations lock bounds", () => {
  test("a DDL blocked by a long read fails with MigrationLockTimeoutError", async () => {
    const folder = await folderWithPendingAlter()
    const reader = createDatabase({ url: fixture.url(), maxConnections: 1 })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      let holding: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        holding = resolve
      })
      const reading = reader.sql.begin(async (tx) => {
        await tx`select count(*) from accounts`
        holding()
        await released
      })
      await held
      const failed = await runMigrations({
        url: fixture.url(),
        migrationsFolder: folder,
        lockTimeoutMs: 300,
      }).catch((error: unknown) => error)
      expect(failed).toBeInstanceOf(MigrationLockTimeoutError)
      release()
      await reading
      // Once the read is gone the same migration applies.
      await runMigrations({ url: fixture.url(), migrationsFolder: folder, lockTimeoutMs: 300 })
    } finally {
      release()
      await reader.close()
      await rm(folder, { recursive: true, force: true })
    }
  })

  test("a replica waiting on another's migration says so, and is not bounded by the lock timeout", async () => {
    const holder = createDatabase({ url: fixture.url(), maxConnections: 1 })
    const waits: string[] = []
    try {
      await holder.sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
      const migrating = runMigrations({
        url: fixture.url(),
        lockTimeoutMs: 100,
        onLockWait: () => waits.push("waiting"),
      })
      await Bun.sleep(500)
      expect(waits).toEqual(["waiting"])
      await holder.sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`
      await migrating
    } finally {
      await holder.close()
    }
  })
})
