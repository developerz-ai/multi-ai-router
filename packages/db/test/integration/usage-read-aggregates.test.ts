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
  type UsageWindow,
} from "../../src/repositories/usage-read-repository"
import { accounts } from "../../src/schema/accounts"
import { type NewUsageRecordRow, usageRecords } from "../../src/schema/usage-records"

/**
 * Needs a real PostgreSQL 16+.
 *
 * The aggregate readers — `totals`, `breakdown`, `series`, `seriesByDimension`, `latency` — are
 * built from raw fragments no unit test can execute: `percentile_disc ... within group`, filtered
 * counts, `date_trunc` over a bound bucket name, and a group-by-ordinal that exists because
 * repeating the bucket expression would bind a second placeholder and unground the select
 * (`usage-read-repository.ts` documents the hazard). Each of them has to run against a live
 * planner at least once, which is this file — the class of gap that let #77 ship broken.
 *
 * Fixtures live in their own far-future day, so a shared dev database cannot bleed rows into the
 * window under test. It never talks to a provider, only to the database, and removes every row it
 * wrote.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

/** A day nothing else writes into — window isolation on a shared database. */
const DAY = "2031-03-01"
const WINDOW: UsageWindow = {
  from: new Date(`${DAY}T00:00:00.000Z`),
  to: new Date("2031-03-02T00:00:00.000Z"),
}
const EMPTY_WINDOW: UsageWindow = {
  from: new Date("2031-06-01T00:00:00.000Z"),
  to: new Date("2031-06-02T00:00:00.000Z"),
}
/** A window whose token sum crosses 2^31 — the overflow that answered the usage page a `500`. */
const BIG_DAY = "2031-09-01"
const BIG_WINDOW: UsageWindow = {
  from: new Date(`${BIG_DAY}T00:00:00.000Z`),
  to: new Date("2031-09-02T00:00:00.000Z"),
}
/** Fits an `integer` column on its own; two of them do not fit an `int` sum. */
const HALF_OVERFLOW = 1_500_000_000

let handle: DatabaseHandle | undefined
let db: Database
let accountsRepo: AccountRepository
let usage: UsageReadRepository

let accountA = ""
let accountB = ""
const accountIds: string[] = []

/** One attempt with every measured field spelled out, at a chosen instant. */
function attempt(
  accountId: string,
  correlationId: string,
  at: string,
  fields: Partial<NewUsageRecordRow>,
): NewUsageRecordRow {
  return {
    correlationId,
    accountId,
    model: "glm-4.6",
    outcome: "success",
    createdAt: new Date(`${DAY}T${at}`),
    ...fields,
  }
}

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
  accountsRepo = createAccountRepository(db)
  usage = createUsageReadRepository(db)

  accountA = (await accountsRepo.create({ label: `test-agg-a-${Date.now()}`, provider: "zai" })).id
  accountB = (await accountsRepo.create({ label: `test-agg-b-${Date.now()}`, provider: "zai" })).id
  accountIds.push(accountA, accountB)

  const c1 = crypto.randomUUID()
  const c2 = crypto.randomUUID()
  const c4 = crypto.randomUUID()
  // Account A: three attempts across two requests (c2 is a two-attempt failover chain) and two
  // hours; one failure; one metered and one notional cost; one attempt with no TTFB.
  // Account B: one clean attempt in a third hour.
  await db.insert(usageRecords).values([
    attempt(accountA, c1, "10:15:00.000Z", {
      tokensIn: 100,
      tokensOut: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      latencyMs: 100,
      routerOverheadMs: 5,
      ttfbMs: 50,
      costEstimate: "0.5",
      costBasis: "metered",
    }),
    attempt(accountA, c2, "10:45:00.000Z", {
      outcome: "upstream_error",
      tokensIn: 20,
      latencyMs: 300,
      routerOverheadMs: 15,
      ttfbMs: null,
      costEstimate: "1.25",
      costBasis: "notional",
    }),
    attempt(accountA, c2, "11:15:00.000Z", {
      tokensIn: 30,
      tokensOut: 3,
      latencyMs: 200,
      routerOverheadMs: 10,
      ttfbMs: 70,
    }),
    attempt(accountB, c4, "14:30:00.000Z", {
      tokensIn: 1_000,
      tokensOut: 100,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
      latencyMs: 400,
      routerOverheadMs: 20,
      ttfbMs: 90,
    }),
  ])

  // Production measured 4.7 billion cache-read tokens over one week; two rows are enough to cross
  // the `int` ceiling the aggregates used to cast through.
  await db.insert(usageRecords).values([
    {
      correlationId: crypto.randomUUID(),
      accountId: accountA,
      model: "glm-4.6",
      outcome: "success",
      createdAt: new Date(`${BIG_DAY}T10:00:00.000Z`),
      cacheReadTokens: HALF_OVERFLOW,
    },
    {
      correlationId: crypto.randomUUID(),
      accountId: accountB,
      model: "glm-4.6",
      outcome: "success",
      createdAt: new Date(`${BIG_DAY}T11:00:00.000Z`),
      cacheReadTokens: HALF_OVERFLOW,
    },
  ])
})

afterAll(async () => {
  if (handle !== undefined && accountIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.accountId, accountIds))
    await db.delete(accounts).where(inArray(accounts.id, accountIds))
  }
  await handle?.close()
})

describe.skipIf(!runnable)("usage aggregates against a live database", () => {
  test("totals: nine measures over the window, requests distinct from attempts", async () => {
    const totals = await usage.totals(WINDOW)

    expect(totals).toMatchObject({
      requests: 3,
      attempts: 4,
      errors: 1,
      tokensIn: 1_150,
      tokensOut: 113,
      cacheReadTokens: 55,
      cacheWriteTokens: 22,
    })
    // Metered and notional stay apart — asserting both proves neither absorbed the other.
    expect(Number(totals.costMetered)).toBeCloseTo(0.5)
    expect(Number(totals.costNotional)).toBeCloseTo(1.25)
  })

  test("totals: a token sum past 2^31 is answered, not raised as integer out of range", async () => {
    const totals = await usage.totals(BIG_WINDOW)

    expect(totals.cacheReadTokens).toBe(2 * HALF_OVERFLOW)
    expect(totals.attempts).toBe(2)
    expect(totals.requests).toBe(2)

    // The same aggregates behind every grouped reader: none may keep an `int` cast of its own.
    const byAccount = await usage.breakdown(BIG_WINDOW, "accountId")
    expect(byAccount.map((row) => row.cacheReadTokens).sort()).toEqual([
      HALF_OVERFLOW,
      HALF_OVERFLOW,
    ])
    const outcomes = await usage.outcomes(BIG_WINDOW)
    expect(outcomes).toEqual([{ outcome: "success", attempts: 2 }])
  })

  test("totals: an empty window answers zeros, not an absent row", async () => {
    const totals = await usage.totals(EMPTY_WINDOW)

    expect(totals.requests).toBe(0)
    expect(totals.attempts).toBe(0)
    expect(Number(totals.costMetered)).toBe(0)
  })

  test("breakdown: grouped by account, biggest first, per-group percentiles", async () => {
    const rows = await usage.breakdown(WINDOW, "accountId")

    expect(rows.map((row) => row.id)).toEqual([accountA, accountB])
    expect(rows[0]).toMatchObject({
      requests: 2,
      attempts: 3,
      errors: 1,
      // percentile_disc answers a latency that actually occurred, per group.
      latencyP50Ms: 200,
      latencyP95Ms: 300,
      routerOverheadP95Ms: 15,
    })
    expect(rows[1]).toMatchObject({ requests: 1, attempts: 1, errors: 0, latencyP50Ms: 400 })
  })

  test("series: hour buckets in order, ISO strings formatted in Postgres", async () => {
    const points = await usage.series(WINDOW, "hour")

    expect(points).toEqual([
      { at: `${DAY}T10:00:00.000Z`, requests: 2, attempts: 2, errors: 1 },
      { at: `${DAY}T11:00:00.000Z`, requests: 1, attempts: 1, errors: 0 },
      { at: `${DAY}T14:00:00.000Z`, requests: 1, attempts: 1, errors: 0 },
    ])
  })

  test("series: the day bucket collapses the same rows to one point", async () => {
    const points = await usage.series(WINDOW, "day")

    expect(points).toEqual([{ at: `${DAY}T00:00:00.000Z`, requests: 3, attempts: 4, errors: 1 }])
  })

  test("seriesByDimension: one query, one point per (group, bucket)", async () => {
    const points = await usage.seriesByDimension(WINDOW, "hour", "accountId")

    // Unordered by contract — sort before comparing.
    const sorted = [...points].sort((a, b) =>
      a.id === b.id ? a.at.localeCompare(b.at) : (a.id ?? "").localeCompare(b.id ?? ""),
    )
    const expected = [
      { id: accountA, at: `${DAY}T10:00:00.000Z`, requests: 2 },
      { id: accountA, at: `${DAY}T11:00:00.000Z`, requests: 1 },
      { id: accountB, at: `${DAY}T14:00:00.000Z`, requests: 1 },
    ].sort((a, b) => (a.id === b.id ? a.at.localeCompare(b.at) : a.id.localeCompare(b.id)))

    expect(sorted).toEqual(expected)
  })

  test("latency: global percentiles, TTFB excluding the attempt that relayed no byte", async () => {
    const latency = await usage.latency(WINDOW)

    expect(latency).toEqual({
      p50Ms: 200,
      p95Ms: 400,
      routerOverheadP95Ms: 20,
      // p95 of {50, 70, 90}: the NULL-ttfb attempt is excluded, not counted as zero.
      ttfbP95Ms: 90,
    })
  })

  test("latency: an empty window is nulls, never zeros", async () => {
    expect(await usage.latency(EMPTY_WINDOW)).toEqual({
      p50Ms: null,
      p95Ms: null,
      routerOverheadP95Ms: null,
      ttfbP95Ms: null,
    })
  })

  test("outcomes: one row per outcome that occurred", async () => {
    const rows = await usage.outcomes(WINDOW)

    const byOutcome = new Map(rows.map((row) => [row.outcome, row.attempts]))
    expect(byOutcome.get("success")).toBe(3)
    expect(byOutcome.get("upstream_error")).toBe(1)
  })
})
