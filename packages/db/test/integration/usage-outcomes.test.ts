import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createUsageReadRepository } from "../../src/repositories/usage-read-repository"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { type NewUsageRecordRow, usageRecords } from "../../src/schema/usage-records"

/**
 * The per-outcome scan behind "3% failed — of which what?", against a real PostgreSQL 16+.
 *
 * A unit test can lock the SQL this builds; only the planner can answer whether the enum column
 * groups the way the console reads it. Two claims are worth a live database:
 *
 * - **Every outcome is its own row.** `quota_exhausted` and `credits_exhausted` are separate
 *   members of the enum and must arrive as separate counts — a `GROUP BY` that folded them, or a
 *   cast that collapsed the enum to a coarser label, is the CLAUDE.md non-negotiable 7 conflation
 *   made permanent in SQL.
 * - **The window is half-open and bounds the scan.** A row one millisecond past `to` is outside
 *   the window, so a count read beside a total from the same window cannot include it.
 *
 * Every fixture is stamped in 1999 under one model name, so a run against a shared development
 * database can only ever see and remove its own rows. It never talks to a provider.
 */
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const MODEL = "test-outcomes-model"
/** Older than any row the router could have written. */
const FROM = new Date("1999-01-01T00:00:00.000Z")
const TO = new Date("1999-01-02T00:00:00.000Z")
/** Exactly `to`, which a half-open window excludes. */
const PAST_THE_END = TO

let handle: DatabaseHandle | undefined
let db: Database

/**
 * One row per call, each its own request. Correlation ids are derived from a counter rather than
 * shared: rows under one id are a failover chain, and eight attempts of one chain is a different
 * fixture from eight requests.
 */
let minted = 0
function row(over: Partial<NewUsageRecordRow> = {}): NewUsageRecordRow {
  minted += 1
  const suffix = String(minted).padStart(12, "0")
  return {
    correlationId: `44444444-4444-4444-8444-${suffix}`,
    model: MODEL,
    outcome: "success",
    createdAt: FROM,
    ...over,
  }
}

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db

  await createUsageRecordRepository(db).insertMany([
    row(),
    row(),
    row(),
    // The pair the whole surface exists to keep apart: same coarse fault, opposite remedies.
    row({ outcome: "quota_exhausted" }),
    row({ outcome: "quota_exhausted" }),
    row({ outcome: "credits_exhausted" }),
    // Never reached an account at all, so `usage_daily` skips it by construction — which is
    // exactly why this reads raw rows.
    row({ outcome: "scope_violation", apiKeyId: null, accountId: null }),
    // Outside the window. Counting it would make the split disagree with the totals beside it.
    row({ outcome: "router_error", createdAt: PAST_THE_END }),
  ])
})

afterAll(async () => {
  if (handle !== undefined) await db.delete(usageRecords).where(eq(usageRecords.model, MODEL))
  await handle?.close()
})

describe.skipIf(!runnable)("the failure split against a live database", () => {
  test("counts every outcome separately, keeping quota and credits apart", async () => {
    const rows = await createUsageReadRepository(db).outcomes({ from: FROM, to: TO })
    const mine = new Map(
      rows.filter((found) => found.attempts > 0).map((found) => [found.outcome, found.attempts]),
    )

    expect(mine.get("quota_exhausted")).toBe(2)
    expect(mine.get("credits_exhausted")).toBe(1)
    // 3 is the forbidden number: the two folded into one "capacity" bucket nobody can act on.
    expect(mine.get("quota_exhausted")).not.toBe(3)
  })

  test("counts an attempt that never reached an account, which the rollup cannot", async () => {
    const rows = await createUsageReadRepository(db).outcomes({ from: FROM, to: TO })
    const found = rows.find((count) => count.outcome === "scope_violation")

    // Grouped by key *and* account in `usage_daily`, this row has neither — and it is the
    // failure an operator most often arrives here to find.
    expect(found?.attempts).toBeGreaterThanOrEqual(1)
  })

  test("the window is half-open, so a row stamped at `to` is outside it", async () => {
    const inside = await createUsageReadRepository(db).outcomes({ from: FROM, to: TO })
    const wider = await createUsageReadRepository(db).outcomes({
      from: FROM,
      to: new Date(TO.getTime() + 1),
    })

    expect(inside.some((count) => count.outcome === "router_error")).toBe(false)
    expect(wider.find((count) => count.outcome === "router_error")?.attempts).toBe(1)
  })

  test("an outcome that did not occur is absent, not a zero row", async () => {
    const rows = await createUsageReadRepository(db).outcomes({ from: FROM, to: TO })

    // The console shows the three headline classes at zero; it decides that, not the database.
    expect(rows.every((count) => count.attempts > 0)).toBe(true)
  })

  test("a window with nothing in it is an empty scan, not a throw", async () => {
    const rows = await createUsageReadRepository(db).outcomes({
      from: new Date("1998-01-01T00:00:00.000Z"),
      to: new Date("1998-01-02T00:00:00.000Z"),
    })

    expect(rows).toEqual([])
  })
})
