import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { eq, inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import { createAuditRepository } from "../../src/repositories/audit-repository"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { accounts } from "../../src/schema/accounts"
import { apiKeys } from "../../src/schema/api-keys"
import { auditEvents } from "../../src/schema/audit-events"
import { usageRecords } from "../../src/schema/usage-records"

/**
 * Needs a real PostgreSQL 16+. A unit test can only lock the SQL a repository
 * builds; whether `delete … where id in (select … limit n)` actually stops at
 * `n`, and whether `returning` counts what was removed, is a question only the
 * planner answers. Both are load-bearing: the janitor runs these against live
 * write traffic and reports `partial` off the count.
 *
 * Every fixture is stamped in 1999 and swept with a year-2000 cutoff, so a run
 * against a shared development database can only ever reach its own rows.
 * It never talks to a provider, only to the database.
 */
const url = process.env.DATABASE_URL ?? ""
const journal = fileURLToPath(new URL("../../migrations/meta/_journal.json", import.meta.url))
const runnable = url !== "" && existsSync(journal)

/** Older than any row the router could have written. */
const ANCIENT = new Date("1999-01-01T00:00:00.000Z")
const CUTOFF = new Date("2000-01-01T00:00:00.000Z")

let handle: DatabaseHandle | undefined
let db: Database

const accountIds: string[] = []
const keyIds: string[] = []

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  db = handle.db
})

afterAll(async () => {
  if (handle !== undefined) {
    // Anything the sweeps under test left behind, plus the rows they are not
    // allowed to touch. A shared dev database must look untouched afterwards.
    if (keyIds.length > 0) await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds))
    if (accountIds.length > 0) await db.delete(accounts).where(inArray(accounts.id, accountIds))
    await db.delete(auditEvents).where(eq(auditEvents.kind, "test.retention"))
    await db.delete(usageRecords).where(eq(usageRecords.model, "test-retention-model"))
  }
  await handle?.close()
})

describe.skipIf(!runnable)("bounded retention deletes against a live database", () => {
  test("usage records: the batch stops at the limit and the count is what went", async () => {
    const repository = createUsageRecordRepository(db)
    const correlationId = "44444444-4444-4444-4444-444444444444"
    await repository.insertMany(
      Array.from({ length: 5 }, () => ({
        correlationId,
        model: "test-retention-model",
        outcome: "success" as const,
        createdAt: ANCIENT,
      })),
    )
    // One row inside the retention window, to prove the cutoff is a cutoff.
    await repository.insertMany([
      { correlationId, model: "test-retention-model", outcome: "success" as const },
    ])

    // A filled batch: five are old, three may go.
    expect(await repository.deleteOlderThan(CUTOFF, 3)).toBe(3)
    // The remainder, in order — the sweep resumes where it stopped.
    expect(await repository.deleteOlderThan(CUTOFF, 3)).toBe(2)
    // Caught up. The recent row is untouched.
    expect(await repository.deleteOlderThan(CUTOFF, 3)).toBe(0)

    const left = await db
      .select({ id: usageRecords.id })
      .from(usageRecords)
      .where(eq(usageRecords.correlationId, correlationId))
    expect(left).toHaveLength(1)
  })

  test("audit events: age is the only thing that removes a row", async () => {
    const repository = createAuditRepository(db)
    for (const subjectType of ["account", "api_key", "pool"]) {
      await db
        .insert(auditEvents)
        .values({ kind: "test.retention", subjectType, createdAt: ANCIENT })
    }
    const recent = await repository.append({ kind: "test.retention", subjectType: "pool" })

    expect(await repository.deleteOlderThan(CUTOFF, 2)).toBe(2)
    expect(await repository.deleteOlderThan(CUTOFF, 2)).toBe(1)
    expect(await repository.deleteOlderThan(CUTOFF, 2)).toBe(0)

    const left = await db.select().from(auditEvents).where(eq(auditEvents.id, recent.id))
    expect(left).toHaveLength(1)
  })

  test("revoked keys: purged by revocation age, and only when revoked", async () => {
    const repository = createApiKeyRepository(db)
    const swept = await repository.create({
      name: "test-retention-swept",
      value: "envelope",
      prefix: "mar_live_aaaa",
    })
    const liveButStamped = await repository.create({
      name: "test-retention-live",
      value: "envelope",
      prefix: "mar_live_bbbb",
    })
    const noStamp = await repository.create({
      name: "test-retention-unstamped",
      value: "envelope",
      prefix: "mar_live_cccc",
    })
    keyIds.push(swept.id, liveButStamped.id, noStamp.id)

    await db
      .update(apiKeys)
      .set({ revoked: true, revokedAt: ANCIENT })
      .where(eq(apiKeys.id, swept.id))
    // Stamped but never revoked: verification still accepts it, so the sweep
    // must not reach it.
    await db.update(apiKeys).set({ revokedAt: ANCIENT }).where(eq(apiKeys.id, liveButStamped.id))
    // Revoked with no stamp: no measurable age, so it stays until one exists.
    await db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.id, noStamp.id))

    expect(await repository.deleteRevokedOlderThan(CUTOFF, 100)).toBe(1)
    expect(await repository.findById(swept.id)).toBeUndefined()
    expect(await repository.findById(liveButStamped.id)).toBeDefined()
    expect(await repository.findById(noStamp.id)).toBeDefined()
  })

  test("quota windows are read back per account, ordered and complete", async () => {
    const repository = createAccountRepository(db)
    const account = await repository.create({ label: "test-retention-acct", provider: "zai" })
    const other = await repository.create({ label: "test-retention-other", provider: "zai" })
    accountIds.push(account.id, other.id)

    const lastCheckedAt = new Date("2026-07-24T12:00:00.000Z")
    await repository.upsertQuotaWindow(account.id, {
      window: "seven_day",
      utilization: 0.5,
      utilizationSource: "continuous",
      resetSource: "unknown",
      lastCheckedAt,
    })
    await repository.upsertQuotaWindow(account.id, {
      window: "five_hour",
      utilizationSource: "threshold-triggered",
      resetSource: "unknown",
      lastCheckedAt,
    })

    const rows = await repository.listQuotaWindows([account.id, other.id])
    expect(rows.map((row) => row.window)).toEqual(["five_hour", "seven_day"])
    // An account that has never been probed contributes nothing, rather than a
    // synthesized full or empty window.
    expect(rows.every((row) => row.accountId === account.id)).toBe(true)
    expect(rows[0]?.utilization).toBeNull()
  })
})
