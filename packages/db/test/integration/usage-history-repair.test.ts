import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createDatabase } from "../../src/client"
import { createUsageRecordRepository } from "../../src/repositories/usage-repository"
import { usageAttemptDailyV2 } from "../../src/schema/usage-aggregate-v2"
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
})
