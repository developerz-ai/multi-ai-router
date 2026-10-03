import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createUsageRecentRepository } from "../../src/repositories/usage-recent-repository"
import {
  createUsageRecordRepository,
  USAGE_RECORD_MAX_BATCH_ROWS,
  type UsageRecordInsert,
} from "../../src/repositories/usage-repository"
import { apiKeys } from "../../src/schema/api-keys"
import { usageRecords } from "../../src/schema/usage-records"

const url = process.env.DATABASE_URL ?? ""
let handle: DatabaseHandle
const ids: string[] = []
function event(over: Partial<UsageRecordInsert> = {}): UsageRecordInsert {
  const id = crypto.randomUUID()
  ids.push(id)
  return {
    id,
    correlationId: crypto.randomUUID(),
    model: null,
    upstreamModel: null,
    responseStatus: 401,
    httpStatus: null,
    outcome: "client_error",
    createdAt: new Date("1998-01-01"),
    ...over,
  }
}
beforeAll(async () => {
  if (!url) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 1 })
})
afterAll(async () => {
  if (!url) return
  await handle.db.delete(usageRecords).where(inArray(usageRecords.id, ids))
  await handle.close()
})
describe.skipIf(!url)("stable usage event identity", () => {
  test("retry after acknowledged commit loss keeps one row per event, not per correlation", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const first = event()
    const second = event({ correlationId: first.correlationId, attempt: 2, responseStatus: 502 })
    const batch = [first, second]
    const commitThenLoseAck = async () => {
      await repo.insertMany(batch)
      throw new Error("ack lost")
    }
    await expect(commitThenLoseAck()).rejects.toThrow("ack lost")
    expect(await repo.insertMany(batch)).toBe(0)
    const persisted = await handle.db
      .select()
      .from(usageRecords)
      .where(
        inArray(
          usageRecords.id,
          batch.map((row) => row.id),
        ),
      )
    expect(persisted).toHaveLength(2)
    expect(persisted.map((row) => row.responseStatus).sort()).toEqual([401, 502])
    const recent = await createUsageRecentRepository(handle.db).recent({
      requestId: first.correlationId,
      limit: 10,
    })
    expect(recent).toHaveLength(2)
    expect(
      recent.every(
        (row) => row.model === null && row.upstreamModel === null && row.httpStatus === null,
      ),
    ).toBe(true)
  })
  test("a fully populated maximum batch fits PostgreSQL's actual bind protocol", async () => {
    const rows = Array.from({ length: USAGE_RECORD_MAX_BATCH_ROWS }, () => ({
      ...event(),
      clientRequestId: null,
      attempt: 1,
      apiKeyId: null,
      accountId: null,
      poolId: null,
      provider: null,
      sessionKey: null,
      ingressDialect: null,
      egressMode: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costEstimate: null,
      costBasis: "unknown" as const,
      latencyMs: 0,
      ttfbMs: null,
      routerOverheadMs: 0,
      streamed: false,
      errorClass: null,
    }))
    expect(await createUsageRecordRepository(handle.db).insertMany(rows)).toBe(
      USAGE_RECORD_MAX_BATCH_ROWS,
    )
  })
  test("duplicate identity never replaces the original facts", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const original = event({ tokensIn: 7 })
    expect(await repo.insertMany([original])).toBe(1)
    expect(await repo.insertMany([{ ...original, tokensIn: 999, responseStatus: 200 }])).toBe(0)
    const [persisted] = await handle.db
      .select()
      .from(usageRecords)
      .where(inArray(usageRecords.id, [original.id]))
    expect(persisted?.tokensIn).toBe(7)
    expect(persisted?.responseStatus).toBe(401)
  })
  test("a replay after subject deletion cannot restore old foreign-key attribution", async () => {
    const [key] = await handle.db
      .insert(apiKeys)
      .values({ name: "usage-retry", value: crypto.randomUUID(), prefix: "fixture" })
      .returning()
    if (!key) throw new Error("missing fixture key")
    try {
      const repo = createUsageRecordRepository(handle.db)
      const row = event({ apiKeyId: key.id })
      expect(await repo.insertMany([row])).toBe(1)
      await handle.db.delete(apiKeys).where(eq(apiKeys.id, key.id))
      expect(await repo.insertMany([row])).toBe(0)
      const [persisted] = await handle.db
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.id, row.id))
      expect(persisted?.apiKeyId).toBeNull()
    } finally {
      await handle.db.delete(apiKeys).where(eq(apiKeys.id, key.id))
    }
  })
  test("primary-key suppression does not swallow foreign-key violations", async () => {
    const repo = createUsageRecordRepository(handle.db)
    const valid = event(),
      invalid = event({ accountId: crypto.randomUUID() })
    await expect(repo.insertMany([valid, invalid])).rejects.toMatchObject({
      cause: { code: "23503" },
    })
    const persisted = await handle.db
      .select()
      .from(usageRecords)
      .where(inArray(usageRecords.id, [valid.id, invalid.id]))
    expect(persisted).toHaveLength(0)
  })
  test("upgrade preserves old model/status facts and makes only new facts nullable", async () => {
    const schema = `usage_upgrade_${crypto.randomUUID().replaceAll("-", "")}`
    await handle.sql.unsafe(`CREATE SCHEMA "${schema}"`)
    try {
      await handle.sql.unsafe(
        `CREATE TABLE "${schema}".usage_records (id uuid PRIMARY KEY, model text NOT NULL, http_status integer)`,
      )
      const id = crypto.randomUUID()
      await handle.sql.unsafe(`INSERT INTO "${schema}".usage_records VALUES ($1, 'legacy', 503)`, [
        id,
      ])
      const migration = await Bun.file(
        new URL("../../migrations/0029_usage_event_status.sql", import.meta.url),
      ).text()
      for (const statement of migration.split("--> statement-breakpoint"))
        await handle.sql.unsafe(
          statement.replaceAll('"usage_records"', `"${schema}"."usage_records"`),
        )
      const [old] = await handle.sql.unsafe<
        { model: string; http_status: number; response_status: number | null }[]
      >(`SELECT model,http_status,response_status FROM "${schema}".usage_records`)
      expect(old).toEqual({ model: "legacy", http_status: 503, response_status: null })
      await handle.sql.unsafe(
        `INSERT INTO "${schema}".usage_records VALUES ($1, NULL, NULL, 401)`,
        [crypto.randomUUID()],
      )
      const [count] = await handle.sql.unsafe<{ count: number }[]>(
        `SELECT count(*)::integer AS count FROM "${schema}".usage_records`,
      )
      expect(count?.count).toBe(2)
    } finally {
      await handle.sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`)
    }
  })
})
