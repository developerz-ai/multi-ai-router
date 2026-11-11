import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDatabase } from "../../src/client"
import {
  defaultMigrationsFolder,
  MigrationPreconditionError,
  runMigrations,
} from "../../src/migrate"
import {
  ApiKeyNameTakenError,
  createApiKeyRepository,
} from "../../src/repositories/api-key-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * 0045 makes key names unique. On a database that already holds a duplicate it must refuse to
 * boot with a named error that names the duplicate — not fail anonymously in the index build, and
 * not rename anything. Once applied, a clash from any writer surfaces as `ApiKeyNameTakenError`.
 */
const migrated = ownDatabaseFixture("migration_0045")

/** The shipped migrations up to and including `lastIdx`, as a folder of their own. */
async function folderThrough(lastIdx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "mar-migrate-0045-"))
  await cp(defaultMigrationsFolder(), folder, { recursive: true })
  const journalPath = join(folder, "meta", "_journal.json")
  const journal = (await Bun.file(journalPath).json()) as { entries: { idx: number }[] }
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx)
  await writeFile(journalPath, JSON.stringify(journal))
  return folder
}

describe.skipIf(ownDatabaseUrl === "")("migration 0045: unique key names", () => {
  test("a duplicate already present fails the boot by name, and applies once it is fixed", async () => {
    const admin = createDatabase({ url: ownDatabaseUrl, maxConnections: 1 })
    const name = `mig_0045_${crypto.randomUUID().replaceAll("-", "")}`
    const uri = new URL(ownDatabaseUrl)
    uri.pathname = `/${name}`
    const url = uri.toString()
    const before = await folderThrough(44)
    try {
      await admin.sql.unsafe(`create database "${name}"`)
      await runMigrations({ url, migrationsFolder: before })
      const db = createDatabase({ url, maxConnections: 1 })
      try {
        await db.sql`insert into api_keys (name, value, prefix) values
          ('laptop', 'v1', 'mar_live_aaaaaaaa'), ('laptop', 'v2', 'mar_live_bbbbbbbb')`

        const failed = await runMigrations({ url }).catch((error: unknown) => error)
        expect(failed).toBeInstanceOf(MigrationPreconditionError)
        expect((failed as Error).message).toContain("'laptop' (2 keys)")
        // Nothing renamed, nothing half-applied.
        const [count] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from api_keys where name = 'laptop'`
        expect(count?.n).toBe(2)

        await db.sql`update api_keys set name = 'laptop-2' where value = 'v2'`
        await runMigrations({ url })
        const [index] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from pg_indexes where indexname = 'api_keys_name_key'`
        expect(index?.n).toBe(1)
      } finally {
        await db.close()
      }
    } finally {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
      await admin.close()
      await rm(before, { recursive: true, force: true })
    }
  }, 60_000)

  test("a clash on create or rename is ApiKeyNameTakenError, and replaying 0045 is a no-op", async () => {
    const keys = createApiKeyRepository(migrated.db())
    await keys.create({ name: "ci-agent", value: "v1", prefix: "mar_live_cccccccc" })
    const other = await keys.create({
      name: "ci-agent-2",
      value: "v2",
      prefix: "mar_live_dddddddd",
    })

    const created = await keys
      .create({ name: "ci-agent", value: "v3", prefix: "mar_live_eeeeeeee" })
      .catch((error: unknown) => error)
    expect(created).toBeInstanceOf(ApiKeyNameTakenError)
    expect((created as ApiKeyNameTakenError).keyName).toBe("ci-agent")

    const renamed = await keys
      .update(other.id, { name: "ci-agent" }, new Date())
      .catch((error: unknown) => error)
    expect(renamed).toBeInstanceOf(ApiKeyNameTakenError)
    // A rename to its own name, or to a free one, is fine.
    expect((await keys.update(other.id, { name: "ci-agent-2" }, new Date()))?.name).toBe(
      "ci-agent-2",
    )

    const file = await Bun.file(
      new URL("../../migrations/0045_api_key_name_unique.sql", import.meta.url),
    ).text()
    for (const statement of file.split("--> statement-breakpoint"))
      await migrated.sql().unsafe(statement)
  })
})
