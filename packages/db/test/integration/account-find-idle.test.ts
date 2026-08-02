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
 * `findIdle` is the reader of the very column the pre-#77 `markUsed` never stamped, and its whole
 * contract lives in one raw `order by ... asc nulls first` fragment: never-used accounts (NULL)
 * must sort ahead of every stamped one, then oldest first. Postgres defaults to NULLS LAST under
 * ASC, so the fragment is load-bearing — and a fragment is exactly what a unit test against an
 * in-memory fake cannot prove. This file stamps through the real writer (`markUsed`) and reads
 * through the real query, so the pair that shipped broken for a year is asserted end to end.
 *
 * It never talks to a provider, only to the database, and removes every row it wrote.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const OLDEST = new Date("2026-07-18T00:00:00.000Z")
const OLD = new Date("2026-07-20T00:00:00.000Z")
const FRESH = new Date("2026-07-30T00:00:00.000Z")
/** Between OLD and FRESH: the boundary that splits "idle" from "recently used". */
const BEFORE = new Date("2026-07-25T00:00:00.000Z")

/** Wide enough that other rows in a shared dev database cannot squeeze ours out of the page. */
const LIMIT = 1_000

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

async function seed(label: string, lastUsedAt?: Date) {
  const row = await repository.create({ label: `test-find-idle-${label}`, provider: "zai" })
  accountIds.push(row.id)
  // Through the real writer, not a direct column write: this is the pair under test.
  if (lastUsedAt !== undefined) await repository.markUsed([row.id], lastUsedAt)
  return row.id
}

describe.skipIf(!runnable)("findIdle against a live database", () => {
  test("never-used sorts first, then oldest stamp; a fresh stamp is not idle", async () => {
    const never = await seed("never")
    const oldest = await seed("oldest", OLDEST)
    const old = await seed("old", OLD)
    const fresh = await seed("fresh", FRESH)

    const rows = await repository.findIdle({ before: BEFORE, limit: LIMIT })
    // The dev database is shared, so assert on our rows' relative order, not absolute positions.
    const mine = rows.map((row) => row.id).filter((id) => accountIds.includes(id))

    expect(mine).toEqual([never, oldest, old])
    expect(mine).not.toContain(fresh)
  })

  test("a disabled account is never offered, however neglected", async () => {
    const disabled = await seed("disabled", OLDEST)
    await repository.disable(disabled, new Date("2026-07-21T00:00:00.000Z"))

    const rows = await repository.findIdle({ before: BEFORE, limit: LIMIT })

    expect(rows.map((row) => row.id)).not.toContain(disabled)
  })

  test("a stamp exactly at the boundary is not idle — the comparison is strict", async () => {
    const boundary = await seed("boundary", BEFORE)

    const rows = await repository.findIdle({ before: BEFORE, limit: LIMIT })

    expect(rows.map((row) => row.id)).not.toContain(boundary)
  })

  test("a non-positive limit asks for nothing and issues no query", async () => {
    expect(await repository.findIdle({ before: BEFORE, limit: 0 })).toEqual([])
    expect(await repository.findIdle({ before: BEFORE, limit: -1 })).toEqual([])
  })
})
