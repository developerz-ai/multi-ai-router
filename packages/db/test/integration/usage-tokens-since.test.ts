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

  /**
   * The bucketed form, which the console's sparkline is drawn from.
   *
   * `width_bucket` is the other thing only a live planner can prove: it refuses a range whose
   * bounds are equal, it numbers from 1, and `extract(epoch from ...)` has to agree with the
   * timestamps the join filters on. All three are invisible to a stub.
   */
  describe("with a shape asked for", () => {
    const shape = { until: NOW, slots: 4 }

    test("spreads the same total across equal slices of the span", async () => {
      const accountId = await seedAccount()
      const since = new Date(NOW.getTime() - 4 * HOUR_MS)

      // One hour per slot, at 4 slots over 4 hours: one row per slice, in order.
      await seedUsage(accountId, new Date(since.getTime() + 30 * 60 * 1_000), 1)
      await seedUsage(accountId, new Date(since.getTime() + HOUR_MS + 30 * 60 * 1_000), 20)
      await seedUsage(accountId, new Date(since.getTime() + 3 * HOUR_MS + 30 * 60 * 1_000), 4_000)

      const [row] = await usage.tokensSince([{ accountId, window: "five_hour", since }], shape)

      expect(row?.series).toEqual([1, 20, 0, 4_000])
      // The bar and the curve are the same measurement — this is what makes that true.
      expect(row?.tokens).toBe(4_021)
    })

    test("an account that recorded nothing is a flat line, not a missing row", async () => {
      const accountId = await seedAccount()

      const [row] = await usage.tokensSince(
        [{ accountId, window: "five_hour", since: new Date(NOW.getTime() - 5 * HOUR_MS) }],
        shape,
      )

      expect(row).toMatchObject({ tokens: 0, series: [0, 0, 0, 0] })
    })

    test("usage after the span's end is outside the window and is not counted", async () => {
      const accountId = await seedAccount()
      const since = new Date(NOW.getTime() - 4 * HOUR_MS)

      await seedUsage(accountId, new Date(since.getTime() + HOUR_MS), 7)
      // An hour past `until`: a clock skew or a late-arriving drain, and not this window's.
      await seedUsage(accountId, new Date(NOW.getTime() + HOUR_MS), 9_999)

      const [row] = await usage.tokensSince([{ accountId, window: "five_hour", since }], shape)

      expect(row?.tokens).toBe(7)
    })

    /**
     * `width_bucket` raises `lower bound cannot equal upper bound`, which would take down the whole
     * accounts screen for one account whose reset instant happens to land on now.
     */
    test("a span with nothing in it is dropped rather than crashing the statement", async () => {
      const accountId = await seedAccount()

      const rows = await usage.tokensSince([{ accountId, window: "five_hour", since: NOW }], shape)

      expect(rows).toEqual([])
    })

    /**
     * `width_bucket` refuses a non-positive bucket count exactly as it refuses equal bounds — a
     * server error on the whole statement. The repository guards it: the bounds still apply (they
     * name the measured range) but no curve is asked for, so a caller bug costs the sparkline and
     * nothing else.
     */
    test("a shape with no positive width degrades to totals without a curve, not an error", async () => {
      const accountId = await seedAccount()
      await seedUsage(accountId, new Date(NOW.getTime() - HOUR_MS), 42)
      // Past `until`, so it also proves the shape's upper bound survives the degraded path.
      await seedUsage(accountId, new Date(NOW.getTime() + HOUR_MS), 9_999)

      for (const slots of [0, -3]) {
        const [row] = await usage.tokensSince(
          [{ accountId, window: "five_hour", since: new Date(NOW.getTime() - 5 * HOUR_MS) }],
          { until: NOW, slots },
        )
        expect(row).toMatchObject({ tokens: 42, series: [] })
      }
    })

    test("each pair keeps its own slicing in one statement", async () => {
      const accountId = await seedAccount()
      await seedUsage(accountId, new Date(NOW.getTime() - 30 * 60 * 1_000), 500)

      const rows = await usage.tokensSince(
        [
          { accountId, window: "five_hour", since: new Date(NOW.getTime() - 4 * HOUR_MS) },
          { accountId, window: "seven_day", since: new Date(NOW.getTime() - 4 * 24 * HOUR_MS) },
        ],
        shape,
      )

      const at = (window: string) => rows.find((row) => row.window === window)
      // The same 500 tokens, half an hour old: the last slice of a four-hour window, and the last
      // slice of a four-day one. Same total, different position — which is the point of per-pair
      // bounds.
      expect(at("five_hour")?.series).toEqual([0, 0, 0, 500])
      expect(at("seven_day")?.series).toEqual([0, 0, 0, 500])
      expect(at("five_hour")?.tokens).toBe(500)
    })
  })
})
