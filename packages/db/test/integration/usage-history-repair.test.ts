import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createDatabase } from "../../src/client"
import { createUsageDailyRepository } from "../../src/repositories/usage-daily-repository"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { usageAttemptDailyV2 } from "../../src/schema/usage-aggregate-v2"
import { usageDaily } from "../../src/schema/usage-daily"
import { usageRecords } from "../../src/schema/usage-records"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

const fixture = usageHistoryFixture()
describe.skipIf(!historyUrl)("atomic receipt reconciliation", () => {
  test("failed repair after DELETE preserves previous groups; successful repair replaces exactly", async () => {
    const row = historyAttempt({ createdAt: new Date("1984-01-11T12:00:00Z") })
    await fixture.usage().insertMany([row])
    await fixture
      .db()
      .update(usageAttemptDailyV2)
      .set({ tokensIn: 99 })
      .where(eq(usageAttemptDailyV2.day, "1984-01-11"))
    await fixture
      .get()
      .sql.unsafe(
        "create function fail_history_repair() returns trigger language plpgsql as $$ begin raise exception 'fixture repair interrupted'; end $$",
      )
    await fixture
      .get()
      .sql.unsafe(
        "create trigger fail_history_repair before insert on usage_attempt_daily_v2 for each row execute function fail_history_repair()",
      )
    try {
      await expect(fixture.history().rollupDay(new Date("1984-01-11"))).rejects.toThrow()
      expect((await fixture.history().totals(fixture.window)).tokensIn).toBe(99)
    } finally {
      await fixture.get().sql.unsafe("drop trigger fail_history_repair on usage_attempt_daily_v2")
      await fixture.get().sql.unsafe("drop function fail_history_repair()")
    }
    expect(await fixture.history().rollupDay(new Date("1984-01-11"))).toBe(1)
    expect((await fixture.history().totals(fixture.window)).tokensIn).toBe(3)
    expect(await fixture.history().rollupDay(new Date("1984-01-11"))).toBe(1)
    expect((await fixture.history().totals(fixture.window)).tokensIn).toBe(3)
  })
  test("empty complete V2 day removes stale groups and future/open days are never reconciled", async () => {
    await fixture
      .db()
      .insert(usageAttemptDailyV2)
      .values({ day: "1984-01-12", basis: "live", attempts: 20 })
    expect(await fixture.history().rollupDay(new Date("1984-01-12"))).toBe(0)
    expect(
      await fixture
        .db()
        .select()
        .from(usageAttemptDailyV2)
        .where(eq(usageAttemptDailyV2.day, "1984-01-12")),
    ).toHaveLength(0)
    await fixture
      .db()
      .insert(usageAttemptDailyV2)
      .values({ day: "2999-01-01", basis: "live", attempts: 20 })
    expect(await fixture.history().rollupDay(new Date("2999-01-01"))).toBe(0)
    expect(
      await fixture
        .db()
        .select()
        .from(usageAttemptDailyV2)
        .where(eq(usageAttemptDailyV2.day, "2999-01-01")),
    ).toHaveLength(1)
  })
  test("one repeatable-read snapshot retains totals and detail while another connection commits", async () => {
    const second = createDatabase({ url: fixture.url(), maxConnections: 1 })
    const row = historyAttempt({ createdAt: new Date("1984-01-15T12:00:00Z") })
    try {
      const snapshot = await fixture.history().withSnapshot(async (history, raw) => {
        const before = await history.totals(fixture.window)
        await createUsageRecordRepository(second.db).insertBatch({
          attempts: [row],
          terminals: [historyTerminal(row)],
        })
        expect(await history.totals(fixture.window)).toEqual(before)
        expect(
          (await raw.totals({ from: new Date("1984-01-15"), to: new Date("1984-01-16") })).attempts,
        ).toBe(0)
        return before
      })
      expect((await fixture.history().totals(fixture.window)).attempts).toBe(snapshot.attempts + 1)
    } finally {
      await second.close()
    }
  })
  test("writer and reconciliation racing on separate connections preserve both contributions", async () => {
    const second = createDatabase({ url: fixture.url(), maxConnections: 1 })
    const a = historyAttempt({ createdAt: new Date("1984-01-18T12:00:00Z") }),
      b = historyAttempt({ createdAt: new Date("1984-01-18T13:00:00Z") })
    try {
      await fixture.usage().insertMany([a])
      await Promise.all([
        createUsageRecordRepository(second.db).insertMany([b]),
        fixture.history().rollupDay(new Date("1984-01-18")),
      ])
      expect(
        (
          await fixture
            .history()
            .totals({ from: new Date("1984-01-18"), to: new Date("1984-01-19") })
        ).attempts,
      ).toBe(2)
    } finally {
      await second.close()
    }
  })
  test("coverage finds exact first-day time after detail purge and honors horizon for pending rows", async () => {
    const rows = [
      historyAttempt({ createdAt: new Date("1984-01-01T20:00:00Z") }),
      historyAttempt({ createdAt: new Date("1984-01-01T03:00:00Z") }),
    ]
    await fixture.usage().insertMany(rows)
    expect((await fixture.history().coverage()).earliestAt?.toISOString()).toBe(
      "1984-01-01T03:00:00.000Z",
    )
    await fixture.usage().deleteOlderThan(new Date("1984-01-02"), 10)
    expect((await fixture.history().coverage()).earliestAt?.toISOString()).toBe(
      "1984-01-01T03:00:00.000Z",
    )
    await fixture.history().deleteOlderThan(new Date("1984-01-02"), 1)
    await fixture
      .db()
      .insert(usageRecords)
      .values(historyAttempt({ createdAt: new Date("1984-01-01T01:00:00Z") }))
    const coverage = await fixture.history().coverage()
    expect(coverage.earliestAt?.toISOString()).toBe("1984-01-03T00:01:00.000Z")
    expect(coverage.incomplete).toBe(false)
  })
  test("compatibility daily retention removes banked/V2 history and receipts while raw detail stays", async () => {
    const row = historyAttempt({ createdAt: new Date("1984-01-25T12:00:00Z") })
    await fixture.usage().insertMany([row])
    await fixture
      .get()
      .sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    try {
      await fixture.db().insert(usageDaily).values({
        day: "1984-01-24",
        apiKeyId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        model: "wrapper-baseline",
        attempts: 4,
      })
    } finally {
      await fixture
        .get()
        .sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
    }
    const daily = createUsageDailyRepository(fixture.db())
    expect(await daily.deleteOlderThan(new Date("1984-01-26"), 100)).toBeGreaterThan(0)
    expect(
      await fixture.db().select().from(usageDaily).where(eq(usageDaily.day, "1984-01-24")),
    ).toHaveLength(0)
    expect(
      await fixture
        .db()
        .select()
        .from(usageAttemptDailyV2)
        .where(eq(usageAttemptDailyV2.day, "1984-01-25")),
    ).toHaveLength(0)
    expect(
      await fixture.db().select().from(usageRecords).where(eq(usageRecords.id, row.id)),
    ).toHaveLength(1)
    expect(
      (await fixture.history().totals({ from: new Date("1984-01-24"), to: new Date("1984-01-26") }))
        .attempts,
    ).toBe(0)
  })
})
