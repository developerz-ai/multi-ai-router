import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"

/**
 * Needs a real PostgreSQL 16+.
 *
 * `markUsed` interpolates its instant into a raw `sql` template, where no column encoder applies —
 * the one place a `Date` reaches the driver unconverted, and the one failure a unit test cannot
 * see: postgres.js refuses the object at bind time, client-side, so no mock and no static check
 * ever observes it. It shipped that way and stamped nothing for days, with every account's
 * `last_used_at` NULL. Only a live bind answers it.
 *
 * It never talks to a provider, only to the database, and removes every row it wrote.
 */
// `DATABASE_URL` and nothing else: `bin/check` refuses to run without one and `bin/test` names this
// file when it skips, so the skip can no longer be silent.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const EARLY = new Date("2026-07-24T12:00:00.000Z")
const LATE = new Date("2026-07-24T13:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database
let repository: AccountRepository

const accountIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  repository = createAccountRepository(db)
})

afterAll(async () => {
  if (handle !== undefined && accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, accountIds))
  }
  await handle?.close()
})

async function seed() {
  const row = await repository.create({
    label: `test-mark-used-${accountIds.length}`,
    provider: "zai",
    status: "active",
  })
  accountIds.push(row.id)
  return row
}

describe.skipIf(!runnable)("markUsed against a live database", () => {
  test("stamps a never-used account — the statement must actually bind and run", async () => {
    const row = await seed()

    await repository.markUsed([row.id], EARLY)

    expect((await repository.findById(row.id))?.lastUsedAt).toEqual(EARLY)
  })

  test("a repeated id in one batch is one stamp, not an error", async () => {
    const row = await seed()

    await repository.markUsed([row.id, row.id], EARLY)

    expect((await repository.findById(row.id))?.lastUsedAt).toEqual(EARLY)
  })

  test("a late flush carrying an older instant never walks the stamp backwards", async () => {
    const row = await seed()

    await repository.markUsed([row.id], LATE)
    await repository.markUsed([row.id], EARLY)

    expect((await repository.findById(row.id))?.lastUsedAt).toEqual(LATE)
  })
})
