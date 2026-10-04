import { describe, expect, test } from "bun:test"
import type { Database, DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import { createOauthStateRepository } from "../../src/repositories/oauth-state-repository"
import { createPriceOverrideRepository } from "../../src/repositories/price-override-repository"
import { createScheduledTaskRepository } from "../../src/repositories/scheduled-task-repository"
import { createSessionRepository } from "../../src/repositories/session-repository"
import { createUsageDailyRepository } from "../../src/repositories/usage-daily-repository"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { usageHistoryFixture } from "./usage-history-fixture"

/**
 * Needs a real PostgreSQL 16+. CI always sets `DATABASE_URL` and `bin/check`
 * refuses to run without one, so this can only skip on a deliberately
 * database-less `bin/test` — which names the gap on its way out. It never talks
 * to a provider, only to the database.
 *
 * The skip turns on `DATABASE_URL` and nothing else. An earlier version also
 * required `migrations/meta/_journal.json` to exist, which made a checkout that
 * had lost its generated SQL skip the very tests that would have caught it.
 * That file is committed: if it goes missing, `runMigrations` throws and this
 * run goes red, which is the point.
 */
const url = process.env.DATABASE_URL ?? ""
const fixture = usageHistoryFixture()
const runnable = url !== ""

let handle: DatabaseHandle | undefined
let db: Database

const accountIds: string[] = []
const apiKeyIds: string[] = []
const poolIds: string[] = []
const scheduledTaskRunIds: string[] = []

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
    await runMigrations({ url: fixture.url(), migrationsFolder: defaultMigrationsFolder() })
    // A restart, a crash mid-upgrade, or two replicas racing must converge.
    await runMigrations({ url: fixture.url(), migrationsFolder: defaultMigrationsFolder() })

    handle = fixture.get()
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
    // The isolated database starts with no other scheduler owners.

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

  /**
   * 0010 backfills the rule "the overflow account is one of the pool's members". Rows written
   * before it could name any account at all, which let a key scoped to that pool reach an account
   * the pool does not hold — so routing now ignores such a reference, and this migration is what
   * keeps an existing deployment's paid fallback working instead of quietly going inert.
   *
   * The shipped SQL is executed here rather than restated: a test that re-types the statement
   * proves only that the test is self-consistent. It is already applied by the run above, so a
   * fresh unbacked row exercises exactly the re-run path the file promises is a no-op.
   */
  test("0010 makes a pre-rule overflow a member, and running it again changes nothing", async () => {
    db = (handle as DatabaseHandle).db
    const live = handle as DatabaseHandle
    const backfill = await Bun.file(
      new URL("../../migrations/0010_overflow_is_a_member.sql", import.meta.url),
    ).text()

    const accountRepository = createAccountRepository(db)
    const member = await accountRepository.create({ label: "test-0010-member", provider: "zai" })
    const outsider = await accountRepository.create({ label: "test-0010-corp", provider: "zai" })
    accountIds.push(member.id, outsider.id)

    const [pool] = await live.sql<{ id: string }[]>`
      insert into pools (name, overflow_account_id)
      values ('test-0010-pool', ${outsider.id}::uuid)
      returning id
    `
    const poolId = (pool as { id: string }).id
    poolIds.push(poolId)
    await live.sql`insert into pool_members (pool_id, account_id) values (${poolId}::uuid, ${member.id}::uuid)`

    const memberIds = async (): Promise<string[]> => {
      const rows = await live.sql<{ account_id: string }[]>`
        select account_id from pool_members where pool_id = ${poolId}::uuid order by account_id
      `
      return rows.map((row) => row.account_id).sort()
    }

    expect(await memberIds()).toEqual([member.id].sort())

    await live.sql.unsafe(backfill)
    expect(await memberIds()).toEqual([member.id, outsider.id].sort())

    // Idempotent: a second replica, a restart mid-upgrade, or a re-run must converge.
    await live.sql.unsafe(backfill)
    expect(await memberIds()).toEqual([member.id, outsider.id].sort())
  })

  test("usage history round-trips immutable attempts and logical terminals", async () => {
    db = (handle as DatabaseHandle).db
    const account = await createAccountRepository(db).create({
      label: "test-migrations-usage-acct",
      provider: "zai",
    })
    accountIds.push(account.id)
    const key = await createApiKeyRepository(db).create({
      name: "test-migrations-usage-key",
      value: crypto.randomUUID(),
      prefix: "fixture",
    })
    apiKeyIds.push(key.id)
    const createdAt = new Date("2026-07-24T12:00:00Z")
    const row = {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      apiKeyId: key.id,
      accountId: account.id,
      model: "test-migrations-model",
      outcome: "success" as const,
      createdAt,
      tokensIn: 11,
      cacheReadTokens: 33,
      costBasis: "metered" as const,
      costEstimate: "1.5",
    }
    const terminal = {
      correlationId: row.correlationId,
      winnerEventId: row.id,
      apiKeyId: key.id,
      accountId: account.id,
      model: row.model,
      outcome: "success" as const,
      responseStatus: 200,
      startedAt: createdAt,
      settledAt: createdAt,
      attributionKind: "winning-attempt" as const,
    }
    const usage = createUsageRecordRepository(db)
    await usage.insertBatch({ attempts: [row], terminals: [terminal] })
    const daily = createUsageDailyRepository(db)
    expect(await daily.rollupDay(createdAt)).toBeGreaterThan(0)
    const breakdown = await daily.breakdown(
      { fromDay: "2026-07-24", toDay: "2026-07-25" },
      "accountId",
    )
    expect(breakdown.find((item) => item.id === account.id)).toMatchObject({
      requests: 1,
      attempts: 1,
      errors: 0,
      tokensIn: 11,
      cacheReadTokens: 33,
    })
    const before = await daily.totals({ fromDay: "2026-07-24", toDay: "2026-07-25" })
    expect(await usage.insertBatch({ attempts: [row], terminals: [terminal] })).toEqual({
      insertedAttempts: 0,
      insertedTerminals: 0,
    })
    await daily.rollupDay(createdAt)
    expect(await daily.totals({ fromDay: "2026-07-24", toDay: "2026-07-25" })).toEqual(before)
  })
})
