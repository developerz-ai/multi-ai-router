import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import {
  createUsageReadRepository,
  type UsageReadRepository,
} from "../../src/repositories/usage-read-repository"
import { accounts } from "../../src/schema/accounts"
import { usageRecords } from "../../src/schema/usage-records"

/**
 * Needs a real PostgreSQL 16+.
 *
 * `tokensSince` is the one query in this repository that is **hand-written SQL over a VALUES join**
 * rather than composed by the query builder, and it exists to answer a question the builder cannot:
 * every (account, window) pair carries its **own** lower bound, because a five-hour window resetting
 * in twenty minutes opened 4h40m ago and "the last five hours" is a different range.
 *
 * A unit test can stub this method and prove every caller behaves. It cannot prove the statement
 * parses — and the first version did not: the alias column was named `window`, which is a **reserved
 * keyword** in Postgres (it introduces a window-function clause), so the whole query was a syntax
 * error and the accounts screen answered `500`. Nothing but a live planner catches that.
 *
 * It never talks to a provider, only to the database, and removes every row it wrote.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const NOW = new Date("2026-07-28T12:00:00.000Z")
const HOUR_MS = 60 * 60 * 1_000

let handle: DatabaseHandle | undefined
let db: Database
let accountsRepo: AccountRepository
let usage: UsageReadRepository

const accountIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  accountsRepo = createAccountRepository(db)
  usage = createUsageReadRepository(db)
})

afterAll(async () => {
  if (handle !== undefined && accountIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.accountId, accountIds))
    await db.delete(accounts).where(inArray(accounts.id, accountIds))
  }
  await handle?.close()
})

async function seedAccount() {
  const row = await accountsRepo.create({
    label: `test-tokens-${accountIds.length}-${Date.now()}`,
    provider: "zai",
  })
  accountIds.push(row.id)
  return row.id
}

/** One usage row, at a chosen instant, with a known token split. */
async function seedUsage(accountId: string, at: Date, tokens: number) {
  await db.insert(usageRecords).values({
    // A real uuid: the column is `uuid`, not text, so a readable label is a type error at runtime.
    correlationId: crypto.randomUUID(),
    accountId,
    model: "glm-4.6",
    outcome: "success",
    createdAt: at,
    tokensIn: tokens,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
}

describe.skipIf(!runnable)("tokensSince against a live database", () => {
  test("the statement parses at all — `window` is a reserved keyword", async () => {
    const accountId = await seedAccount()

    // The regression this file exists for. An empty result is fine; a throw is not.
    const rows = await usage.tokensSince([
      { accountId, window: "five_hour", since: new Date(NOW.getTime() - 5 * HOUR_MS) },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ accountId, window: "five_hour", tokens: 0 })
  })

  test("counts only what falls inside the span, and sums every billed token kind", async () => {
    const accountId = await seedAccount()
    const since = new Date(NOW.getTime() - 5 * HOUR_MS)

    await seedUsage(accountId, new Date(since.getTime() + HOUR_MS), 100)
    await seedUsage(accountId, new Date(since.getTime() + 2 * HOUR_MS), 250)
    // Before the window opened — belongs to the previous one, and must not be swept in.
    await seedUsage(accountId, new Date(since.getTime() - HOUR_MS), 9_000)

    const [row] = await usage.tokensSince([{ accountId, window: "five_hour", since }])

    expect(row?.tokens).toBe(350)
  })

  test("each pair gets its own lower bound, in one statement", async () => {
    const busy = await seedAccount()
    const quiet = await seedAccount()

    await seedUsage(busy, new Date(NOW.getTime() - HOUR_MS), 500)
    // Four days back: inside a seven-day window, outside a five-hour one.
    await seedUsage(quiet, new Date(NOW.getTime() - 4 * 24 * HOUR_MS), 700)

    const rows = await usage.tokensSince([
      { accountId: busy, window: "five_hour", since: new Date(NOW.getTime() - 5 * HOUR_MS) },
      { accountId: quiet, window: "five_hour", since: new Date(NOW.getTime() - 5 * HOUR_MS) },
      { accountId: quiet, window: "seven_day", since: new Date(NOW.getTime() - 7 * 24 * HOUR_MS) },
    ])

    const at = (id: string, window: string) =>
      rows.find((row) => row.accountId === id && row.window === window)?.tokens

    expect(at(busy, "five_hour")).toBe(500)
    // The same account, two windows, two different answers from one query.
    expect(at(quiet, "five_hour")).toBe(0)
    expect(at(quiet, "seven_day")).toBe(700)
  })

  test("an account that recorded nothing reports zero rather than dropping out", async () => {
    const accountId = await seedAccount()

    const [row] = await usage.tokensSince([
      { accountId, window: "seven_day", since: new Date(NOW.getTime() - 7 * 24 * HOUR_MS) },
    ])

    // A missing row would render as "no reading" and hide a genuinely idle account's bar.
    expect(row?.tokens).toBe(0)
  })

  test("no spans means no query", async () => {
    expect(await usage.tokensSince([])).toEqual([])
  })
})
