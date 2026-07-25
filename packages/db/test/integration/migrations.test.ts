import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { eq, inArray } from "drizzle-orm"
import { createDatabase, type Database, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import { createOauthStateRepository } from "../../src/repositories/oauth-state-repository"
import { createPriceOverrideRepository } from "../../src/repositories/price-override-repository"
import { createScheduledTaskRepository } from "../../src/repositories/scheduled-task-repository"
import { createSessionRepository } from "../../src/repositories/session-repository"
import { createUsageDailyRepository } from "../../src/repositories/usage-daily-repository"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { accounts } from "../../src/schema/accounts"
import { apiKeys } from "../../src/schema/api-keys"
import { oauthStates } from "../../src/schema/oauth-states"
import { priceOverrides } from "../../src/schema/price-overrides"
import { scheduledTaskRuns } from "../../src/schema/scheduled-task-runs"
import { usageDaily } from "../../src/schema/usage-daily"
import { usageRecords } from "../../src/schema/usage-records"

/**
 * Needs a real PostgreSQL 16+. CI sets `DATABASE_URL`; a local run may not, and
 * the generated SQL may not exist yet — either way this skips cleanly instead of
 * failing. It never talks to a provider, only to the database.
 */
const url = process.env.DATABASE_URL ?? ""
const journal = fileURLToPath(new URL("../../migrations/meta/_journal.json", import.meta.url))
const runnable = url !== "" && existsSync(journal)

let handle: DatabaseHandle | undefined
let db: Database

const accountIds: string[] = []
const apiKeyIds: string[] = []
const scheduledTaskRunIds: string[] = []

afterAll(async () => {
  if (handle !== undefined) {
    if (apiKeyIds.length > 0) await db.delete(apiKeys).where(inArray(apiKeys.id, apiKeyIds))
    if (accountIds.length > 0) await db.delete(accounts).where(inArray(accounts.id, accountIds))
    if (scheduledTaskRunIds.length > 0) {
      await db.delete(scheduledTaskRuns).where(inArray(scheduledTaskRuns.id, scheduledTaskRunIds))
    }
    // The whole table, not a fixture subset: `replaceAll` clears it by design, so anything that
    // was here is already gone and leaving it empty is the only honest teardown.
    await db.delete(priceOverrides)
    await db.delete(usageDaily).where(eq(usageDaily.model, "test-migrations-model"))
    await db.delete(usageRecords).where(eq(usageRecords.model, "test-migrations-model"))
    await db.delete(oauthStates).where(eq(oauthStates.state, "test-migrations-state"))
  }
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
  "price_overrides",
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

  test("session round-trips through insert, lookup, and account clearing", async () => {
    db = (handle as DatabaseHandle).db
    const accountRepository = createAccountRepository(db)
    const apiKeyRepository = createApiKeyRepository(db)
    const sessionRepository = createSessionRepository(db)

    const account = await accountRepository.create({
      label: "test-migrations-acct",
      provider: "zai",
    })
    accountIds.push(account.id)
    const apiKey = await apiKeyRepository.create({
      name: "test-migrations-key",
      value: "envelope",
      prefix: "mar_live_zzzz",
    })
    apiKeyIds.push(apiKey.id)

    const lastUsedAt = new Date("2026-07-24T12:00:00.000Z")
    const created = await sessionRepository.upsert({
      apiKeyId: apiKey.id,
      key: "test-migrations-session",
      accountId: account.id,
      sdkSessionId: "sdk-session-1",
      lastUsedAt,
    })
    expect(created.accountId).toBe(account.id)

    const found = await sessionRepository.findByKey(apiKey.id, "test-migrations-session")
    expect(found?.sdkSessionId).toBe("sdk-session-1")

    const cleared = await sessionRepository.clearAccount(account.id)
    expect(cleared).toBe(1)
    const afterClear = await sessionRepository.findByKey(apiKey.id, "test-migrations-session")
    expect(afterClear?.accountId).toBeNull()
    expect(afterClear?.sdkSessionId).toBeNull()
  })

  test("oauth state round-trips through create and a one-shot consume", async () => {
    db = (handle as DatabaseHandle).db
    const repository = createOauthStateRepository(db)
    const now = new Date("2026-07-24T12:00:00.000Z")
    const expiresAt = new Date("2026-07-24T12:10:00.000Z")

    const created = await repository.create({
      state: "test-migrations-state",
      codeVerifier: "envelope",
      provider: "openai-oauth",
      expiresAt,
    })
    expect(created.consumedAt).toBeNull()

    const consumed = await repository.consume("test-migrations-state", now)
    expect(consumed?.id).toBe(created.id)

    // A second presentation of the same state must be rejected, not re-consumed.
    const replayed = await repository.consume("test-migrations-state", now)
    expect(replayed).toBeUndefined()
  })

  test("scheduled task run round-trips through begin and finish", async () => {
    db = (handle as DatabaseHandle).db
    const repository = createScheduledTaskRepository(db)
    const startedAt = new Date("2026-07-24T12:00:00.000Z")
    const finishedAt = new Date("2026-07-24T12:05:00.000Z")

    const id = await repository.begin("quota_floor_refresh", startedAt)
    scheduledTaskRunIds.push(id)

    const finished = await repository.finish(
      id,
      { outcome: "success", itemsProcessed: 3 },
      finishedAt,
    )
    expect(finished?.outcome).toBe("success")
    expect(finished?.itemsProcessed).toBe(3)

    const last = await repository.lastRun("quota_floor_refresh")
    expect(last?.id).toBe(id)
  })

  test("price overrides round-trip through replaceAll and list", async () => {
    db = (handle as DatabaseHandle).db
    const repository = createPriceOverrideRepository(db)
    const now = new Date("2026-07-24T12:00:00.000Z")

    const replaced = await repository.replaceAll(
      [
        {
          provider: "zai",
          model: "test-migrations-glm",
          inputPerMtok: 0.6,
          outputPerMtok: 2.2,
          cacheReadPerMtok: 0.11,
          cacheWritePerMtok: 0.75,
        },
        {
          provider: "anthropic-api",
          model: "test-migrations-sonnet",
          inputPerMtok: 3,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.3,
          cacheWritePerMtok: 3.75,
        },
      ],
      now,
    )

    // Provider then model, and provider sorts in the enum's declared order — `anthropic-api`
    // is declared before `zai`, so the insert order is not the read order.
    expect(replaced.map((row) => row.model)).toEqual([
      "test-migrations-sonnet",
      "test-migrations-glm",
    ])
    // Numbers, not numeric strings: no caller should have to parse a price back out of the row.
    expect(replaced[0]?.inputPerMtok).toBe(3)
    expect(replaced[0]?.cacheWritePerMtok).toBe(3.75)
    expect(replaced[1]?.inputPerMtok).toBe(0.6)
    expect(replaced[0]?.createdAt.toISOString()).toBe(now.toISOString())

    const listed = await repository.list()
    expect(listed.map((row) => row.model)).toEqual(replaced.map((row) => row.model))
  })

  test("a duplicated model rolls the whole replace back", async () => {
    db = (handle as DatabaseHandle).db
    const repository = createPriceOverrideRepository(db)
    const duplicate = {
      provider: "openrouter",
      model: "test-migrations-dupe",
      inputPerMtok: 1,
      outputPerMtok: 1,
      cacheReadPerMtok: 1,
      cacheWritePerMtok: 1,
    } as const

    await expect(
      repository.replaceAll([duplicate, duplicate], new Date("2026-07-24T12:00:00.000Z")),
    ).rejects.toThrow()

    // The transaction is the point: a rejected edit leaves the previous table intact rather than
    // half of it, and a half-applied price table prices reports against rates nobody chose.
    const listed = await repository.list()
    expect(listed.map((row) => row.model)).toEqual([
      "test-migrations-sonnet",
      "test-migrations-glm",
    ])
  })

  test("an empty replace clears the table", async () => {
    db = (handle as DatabaseHandle).db
    const repository = createPriceOverrideRepository(db)

    expect(await repository.replaceAll([], new Date("2026-07-24T12:00:00.000Z"))).toEqual([])
    expect(await repository.list()).toEqual([])
  })

  test("usage daily rollup round-trips from raw usage records", async () => {
    db = (handle as DatabaseHandle).db
    const accountRepository = createAccountRepository(db)
    const apiKeyRepository = createApiKeyRepository(db)
    const usageRepository = createUsageRecordRepository(db)
    const dailyRepository = createUsageDailyRepository(db)
    const createdAt = new Date("2026-07-24T12:00:00.000Z")

    // The rollup skips attempts that never reached an account, so both an
    // account and a key are required for a row to survive into `usage_daily`.
    const account = await accountRepository.create({
      label: "test-migrations-usage-acct",
      provider: "zai",
    })
    accountIds.push(account.id)
    const apiKey = await apiKeyRepository.create({
      name: "test-migrations-usage-key",
      value: "envelope",
      prefix: "mar_live_yyyy",
    })
    apiKeyIds.push(apiKey.id)

    await usageRepository.insertMany([
      {
        correlationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        apiKeyId: apiKey.id,
        accountId: account.id,
        model: "test-migrations-model",
        outcome: "success",
        createdAt,
      },
    ])

    const rolled = await dailyRepository.rollup(
      new Date("2026-07-24T00:00:00.000Z"),
      new Date("2026-07-25T00:00:00.000Z"),
    )
    expect(rolled).toBeGreaterThan(0)

    const totals = await dailyRepository.totals({ fromDay: "2026-07-24", toDay: "2026-07-25" })
    expect(totals.requests).toBeGreaterThan(0)
  })
})
