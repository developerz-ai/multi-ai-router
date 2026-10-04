import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { usageContributions } from "../../src/schema/usage-contributions"
import { usageDaily } from "../../src/schema/usage-daily"
import { usageRecords } from "../../src/schema/usage-records"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

const fixture = usageHistoryFixture()
describe.skipIf(!historyUrl)("rolling legacy writer protection", () => {
  test("the shipped two-step cutover preserves preexisting source era and defaults rolling inserts", async () => {
    const schema = `cutover_${crypto.randomUUID().replaceAll("-", "")}`
    await fixture.get().sql.unsafe(`create schema "${schema}"`)
    try {
      await fixture.get().sql.unsafe(`create table "${schema}".usage_records (id uuid primary key)`)
      await fixture
        .get()
        .sql.unsafe(`insert into "${schema}".usage_records values ($1)`, [crypto.randomUUID()])
      const migration = await Bun.file(
        new URL("../../migrations/0030_usage_history.sql", import.meta.url),
      ).text()
      const statements = migration
        .split("--> statement-breakpoint")
        .filter(
          (statement) =>
            statement.includes('ALTER TABLE "usage_records"') &&
            statement.includes('"ingested_at"'),
        )
      expect(statements).toHaveLength(2)
      for (const statement of statements)
        await fixture
          .get()
          .sql.unsafe(statement.replaceAll('"usage_records"', `"${schema}"."usage_records"`))
      const [old] = await fixture
        .get()
        .sql.unsafe(`select ingested_at from "${schema}".usage_records`)
      expect(old?.ingested_at).toBeNull()
      const [fresh] = await fixture
        .get()
        .sql.unsafe(
          `insert into "${schema}".usage_records (id) values ($1) returning ingested_at`,
          [crypto.randomUUID()],
        )
      expect(Number.isFinite(new Date(String(fresh?.ingested_at)).getTime())).toBe(true)
    } finally {
      await fixture.get().sql.unsafe(`drop schema "${schema}" cascade`)
    }
  })
  test("old writer defaults identify overlap, old janitor cannot erase unregistered evidence", async () => {
    const row = historyAttempt()
    const [stored] = await fixture.db().insert(usageRecords).values(row).returning()
    expect(stored?.ingestedAt).toBeInstanceOf(Date)
    expect(
      await fixture.db().delete(usageRecords).where(eq(usageRecords.id, row.id)).returning(),
    ).toHaveLength(0)
    expect((await fixture.history().coverage()).earliestAt?.toISOString()).toBe(
      row.createdAt?.toISOString(),
    )
    await fixture.history().backfill({ limit: 1 })
    expect(await fixture.history().totals(fixture.window)).toMatchObject({
      attempts: 1,
      requests: 0,
      tokensIn: 3,
    })
    expect(await fixture.history().coverage(fixture.window)).toMatchObject({
      legacy: true,
      incomplete: true,
      requestsBasis: "mixed-legacy",
    })
    const [receipt] = await fixture
      .db()
      .select()
      .from(usageContributions)
      .where(eq(usageContributions.id, row.id))
    expect(receipt?.source).toBe("legacy_overlap")
    expect(
      await fixture.db().delete(usageRecords).where(eq(usageRecords.id, row.id)).returning(),
    ).toHaveLength(1)
  })
  test("sealed baseline rejects old rollups and old janitor but authorized horizon can expire it", async () => {
    const value = {
      day: "1984-01-04",
      apiKeyId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      model: "old",
      attempts: 7,
    }
    await fixture
      .get()
      .sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    await fixture.db().insert(usageDaily).values(value)
    await fixture
      .get()
      .sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
    await expect(
      Promise.resolve(
        fixture
          .db()
          .insert(usageDaily)
          .values({ ...value, model: "new" }),
      ),
    ).rejects.toMatchObject({
      cause: { code: "P0001", message: "legacy usage baseline is sealed" },
    })
    await expect(
      Promise.resolve(fixture.db().update(usageDaily).set({ attempts: 99 })),
    ).rejects.toMatchObject({
      cause: { code: "P0001", message: "legacy usage baseline is sealed" },
    })
    expect(await fixture.db().delete(usageDaily).returning()).toHaveLength(0)
    expect((await fixture.history().totals(fixture.window)).attempts).toBe(8)
    await fixture.history().deleteOlderThan(new Date("1984-01-05"), 100)
    expect(await fixture.db().select().from(usageDaily)).toHaveLength(0)
  })
  test("duplicate immutable identities reject the whole batch before durable contributions", async () => {
    const row = historyAttempt({ createdAt: new Date("1984-01-06") })
    await expect(
      fixture.usage().insertBatch({ attempts: [row, { ...row, tokensIn: 99 }], terminals: [] }),
    ).rejects.toThrow("identity")
    expect(
      await fixture.db().select().from(usageRecords).where(eq(usageRecords.id, row.id)),
    ).toHaveLength(0)
    const terminal = historyTerminal(row, { settledAt: new Date("1984-01-07") })
    await expect(
      fixture.usage().insertBatch({
        attempts: [row],
        terminals: [terminal, { ...terminal, responseStatus: 503 }],
      }),
    ).rejects.toThrow("identity")
    expect(
      await fixture.db().select().from(usageRecords).where(eq(usageRecords.id, row.id)),
    ).toHaveLength(0)
    expect(
      await fixture.usage().insertBatch({ attempts: [row, row], terminals: [terminal, terminal] }),
    ).toEqual({ insertedAttempts: 1, insertedTerminals: 1 })
  })
  test("batch admission of an existing overlapping raw fact keeps stored evidence and unknown requests", async () => {
    const row = historyAttempt({ createdAt: new Date("1984-01-08") })
    await fixture.db().insert(usageRecords).values(row)
    await fixture.usage().insertMany([{ ...row, tokensIn: 999 }])
    const [receipt] = await fixture
      .db()
      .select()
      .from(usageContributions)
      .where(eq(usageContributions.id, row.id))
    expect(receipt?.source).toBe("legacy_overlap")
    expect(receipt?.payload.tokensIn).toBe(3)
    expect(
      await fixture
        .history()
        .coverage({ from: new Date("1984-01-08"), to: new Date("1984-01-09") }),
    ).toMatchObject({ requestsBasis: "mixed-legacy", incomplete: true })
  })
})
