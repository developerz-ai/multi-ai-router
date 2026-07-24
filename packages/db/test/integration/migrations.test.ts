import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"

/**
 * Needs a real PostgreSQL 16+. CI sets `DATABASE_URL`; a local run may not, and
 * the generated SQL may not exist yet — either way this skips cleanly instead of
 * failing. It never talks to a provider, only to the database.
 */
const url = process.env.DATABASE_URL ?? ""
const journal = fileURLToPath(new URL("../../migrations/meta/_journal.json", import.meta.url))
const runnable = url !== "" && existsSync(journal)

let handle: DatabaseHandle | undefined

afterAll(async () => {
  await handle?.close()
})

const EXPECTED_TABLES = [
  "accounts",
  "quota_windows",
  "pools",
  "pool_members",
  "api_keys",
  "api_key_pools",
  "api_key_accounts",
  "sessions",
  "usage_records",
  "usage_daily",
  "audit_events",
  "scheduled_task_runs",
  "oauth_states",
] as const

describe.skipIf(!runnable)("migrations against a live database", () => {
  test("apply cleanly and are idempotent when run twice", async () => {
    await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
    // A restart, a crash mid-upgrade, or two replicas racing must converge.
    await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })

    handle = createDatabase({ url, maxConnections: 2 })
    const rows = await handle.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `
    const tables = rows.map((row) => row.table_name)

    for (const expected of EXPECTED_TABLES) {
      expect(tables).toContain(expected)
    }
  })
})
