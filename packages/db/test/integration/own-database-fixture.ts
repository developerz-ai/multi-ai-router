import { afterAll, beforeAll } from "bun:test"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"

export const ownDatabaseUrl = process.env.DATABASE_URL ?? ""

/**
 * A disposable, fully migrated database per suite, dropped afterwards: the dev database is shared
 * with other suites and a running `bin/dev`, so a suite that writes whole-table state (sessions,
 * task runs, accounts) must never see — or be seen by — anyone else's rows.
 */
export function ownDatabaseFixture(prefix: string, maxConnections = 2) {
  let admin: DatabaseHandle | undefined
  let handle: DatabaseHandle | undefined
  let fixtureUrl = ""
  const name = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
  beforeAll(async () => {
    if (ownDatabaseUrl === "") return
    admin = createDatabase({ url: ownDatabaseUrl, maxConnections: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    const uri = new URL(ownDatabaseUrl)
    uri.pathname = `/${name}`
    fixtureUrl = uri.toString()
    await runMigrations({ url: fixtureUrl, migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url: fixtureUrl, maxConnections })
    // Creating a database and running every migration outlasts bun's 5 s hook default.
  }, 60_000)
  afterAll(async () => {
    try {
      await handle?.close()
    } finally {
      try {
        await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
      } finally {
        await admin?.close()
      }
    }
  }, 30_000)
  const get = (): DatabaseHandle => {
    if (handle === undefined) throw new Error("own database fixture uninitialized")
    return handle
  }
  return { get, db: () => get().db, sql: () => get().sql, url: () => fixtureUrl }
}
