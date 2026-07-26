import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createUsageRecentRepository } from "../../src/repositories/usage-recent-repository"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { type NewUsageRecordRow, usageRecords } from "../../src/schema/usage-records"

/**
 * The live request feed against a real PostgreSQL 16+.
 *
 * A unit test can only lock the SQL this repository builds. Two of its claims are things only the
 * planner can answer, and both are the kind that fail loudly in production and silently in a mock:
 *
 * - **A caller's `x-request-id` is not a uuid.** `correlation_id` is a `uuid` column, and handing
 *   `req-42` to a `uuid` comparison is a Postgres *error*, not a non-match. The `::text` cast is
 *   what makes the lookup accept the value it exists to accept.
 * - **`created_at` alone does not order a feed.** Attempts of one failover chain are written from
 *   one batch and can share a millisecond; the `id` tiebreaker is what stops a page reshuffling
 *   between two refreshes.
 *
 * Every fixture is stamped in 1999 under one model name, so a run against a shared development
 * database can only ever see and remove its own rows. It never talks to a provider.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const MODEL = "test-recent-model"
/** Older than any row the router could have written. */
const ANCIENT = new Date("1999-01-01T00:00:00.000Z")

/** Fixed so the `id` tiebreaker is assertable: `b…` sorts after `a…` descending. */
const ID_A = "aaaaaaaa-0000-4000-8000-000000000001"
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002"

const CHAIN = "33333333-3333-4333-8333-333333333333"
const OTHER_CHAIN = "55555555-5555-4555-8555-555555555555"
/**
 * A caller's own label — deliberately not a uuid, which is the whole point of the lookup, and
 * deliberately prefixed: a shared development database may hold a real `req-42` from someone's
 * smoke test, and a fixture that assumes otherwise fails for a reason that has nothing to do with
 * the code under test.
 */
const CLIENT_ID = "test-recent-req-42"

let handle: DatabaseHandle | undefined
let db: Database

function row(over: Partial<NewUsageRecordRow> = {}): NewUsageRecordRow {
  return {
    correlationId: CHAIN,
    model: MODEL,
    outcome: "success",
    createdAt: ANCIENT,
    sessionKey: "session-that-must-not-be-returned",
    ...over,
  }
}

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db

  await createUsageRecordRepository(db).insertMany([
    // One failover chain: two attempts sharing a correlation id *and* an instant.
    row({ id: ID_A, attempt: 1, outcome: "quota_exhausted", clientRequestId: CLIENT_ID }),
    row({ id: ID_B, attempt: 2, outcome: "success", clientRequestId: CLIENT_ID }),
    // A newer, unrelated request the router minted the id for — no client id at all.
    row({
      correlationId: OTHER_CHAIN,
      createdAt: new Date("1999-06-01T00:00:00.000Z"),
      outcome: "upstream_error",
      httpStatus: 503,
      errorClass: "UpstreamError",
    }),
  ])
})

afterAll(async () => {
  if (handle !== undefined) await db.delete(usageRecords).where(eq(usageRecords.model, MODEL))
  await handle?.close()
})

describe.skipIf(!runnable)("the live request feed against a live database", () => {
  test("finds a request by the caller's own id, which is not a uuid", async () => {
    const rows = await createUsageRecentRepository(db).recent({ limit: 10, requestId: CLIENT_ID })

    // A `uuid = 'req-42'` comparison would have thrown before returning anything.
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((found) => found.clientRequestId))).toEqual(new Set([CLIENT_ID]))
  })

  test("finds the same request by the router's correlation id", async () => {
    const rows = await createUsageRecentRepository(db).recent({ limit: 10, requestId: CHAIN })

    // One id box, either kind: an operator holding an id off a failed run does
    // not know which of the two they have.
    expect(rows).toHaveLength(2)
    expect(rows.map((found) => found.attempt).sort()).toEqual([1, 2])
  })

  test("orders newest first and breaks a tie on id, so a refresh cannot reshuffle", async () => {
    const repository = createUsageRecentRepository(db)

    const first = await repository.recent({ limit: 10, requestId: CLIENT_ID })
    const second = await repository.recent({ limit: 10, requestId: CLIENT_ID })

    // Same instant on both rows, so only the tiebreaker decides — twice the same way.
    expect(first.map((found) => found.id)).toEqual([ID_B, ID_A])
    expect(second.map((found) => found.id)).toEqual(first.map((found) => found.id))
  })

  test("stops at the limit", async () => {
    const rows = await createUsageRecentRepository(db).recent({ limit: 1, requestId: CLIENT_ID })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(ID_B)
  })

  test("narrows to the outcomes asked for, and to nothing else", async () => {
    const rows = await createUsageRecentRepository(db).recent({
      limit: 10,
      requestId: CLIENT_ID,
      outcomes: ["quota_exhausted"],
    })

    expect(rows.map((found) => found.id)).toEqual([ID_A])
  })

  test("an id nothing carries matches nothing, rather than erroring", async () => {
    const rows = await createUsageRecentRepository(db).recent({
      limit: 10,
      requestId: "test-recent-req-nothing",
    })

    expect(rows).toEqual([])
  })

  test("returns the named columns and not one column more", async () => {
    const rows = await createUsageRecentRepository(db).recent({ limit: 1, requestId: OTHER_CHAIN })

    const [found] = rows
    expect(found).toBeDefined()
    // `sessionKey` is on the table and on the fixture, and must not be on an admin screen.
    expect(Object.keys(found ?? {})).not.toContain("sessionKey")
    expect(Object.keys(found ?? {})).not.toContain("costEstimate")
    // What the feed is for: which request, on what, and how it ended.
    expect(found).toMatchObject({
      outcome: "upstream_error",
      httpStatus: 503,
      errorClass: "UpstreamError",
      model: MODEL,
      clientRequestId: null,
    })
  })
})
