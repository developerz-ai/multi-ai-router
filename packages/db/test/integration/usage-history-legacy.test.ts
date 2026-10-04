import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createUsageHistoryMaintenance } from "../../src/repositories/usage-history-maintenance"
import { accounts } from "../../src/schema/accounts"
import { usageContributions } from "../../src/schema/usage-contributions"
import { usageDaily } from "../../src/schema/usage-daily"
import { usageRecords } from "../../src/schema/usage-records"
import { usageRequestTerminals } from "../../src/schema/usage-request-terminals"
import { historyAttempt, historyUrl, usageHistoryFixture } from "./usage-history-fixture"

const fixture = usageHistoryFixture()
describe.skipIf(!historyUrl)("conservative resumable legacy history", () => {
  test("banked history plus old FK deletion is never recounted as a new NULL contribution", async () => {
    const account = await createAccountRepository(fixture.db()).create({
      label: "legacy",
      provider: "zai",
    })
    const old = historyAttempt({
      accountId: account.id,
      apiKeyId: crypto.randomUUID(),
      model: "legacy",
      createdAt: new Date("1984-01-05T12:00:00Z"),
    })
    await fixture
      .get()
      .sql.unsafe(
        "alter table usage_records add constraint fixture_legacy_fk foreign key(account_id) references accounts(id) on delete set null",
      )
    await fixture
      .db()
      .insert(usageRecords)
      .values({ ...old, ingestedAt: null })
    await fixture
      .get()
      .sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    await fixture
      .db()
      .insert(usageDaily)
      .values({
        day: "1984-01-05",
        apiKeyId: old.apiKeyId as string,
        accountId: account.id,
        model: "legacy",
        requests: 7,
        attempts: 7,
        tokensIn: 21,
        costMetered: "0.700000",
      })
    await fixture
      .get()
      .sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
    await fixture.db().delete(accounts).where(eq(accounts.id, account.id))
    await fixture.get().sql.unsafe("alter table usage_records drop constraint fixture_legacy_fk")
    const before = await fixture.history().totals(fixture.window)
    expect(await fixture.history().backfill({ limit: 1 })).toEqual({
      processed: 1,
      remaining: true,
    })
    expect(await fixture.history().backfill({ limit: 1 })).toEqual({
      processed: 0,
      remaining: false,
    })
    expect(await fixture.history().totals(fixture.window)).toEqual(before)
    expect(await fixture.history().coverage(fixture.window)).toMatchObject({
      legacy: true,
      incomplete: true,
      requestsBasis: "mixed-legacy",
    })
  })
  test("unbanked legacy contributes known attempts only, without inventing terminal owner or settlement", async () => {
    const rows = [
      historyAttempt({ createdAt: new Date("1984-01-06T12:00:00Z") }),
      historyAttempt({ createdAt: new Date("1984-01-06T13:00:00Z") }),
    ]
    await fixture
      .db()
      .insert(usageRecords)
      .values(rows.map((row) => ({ ...row, ingestedAt: null })))
    const pending = await fixture.history().coverage()
    expect(pending.incomplete).toBe(true)
    expect(await fixture.usage().deleteOlderThan(new Date("1984-01-07"), 10)).toBe(1) // already-accounted prior baseline raw only
    let first = await fixture.history().backfill({ limit: 1 })
    expect(first.processed).toBe(1)
    first = await fixture.history().backfill({ limit: 1 })
    expect(first.processed).toBe(1)
    expect((await fixture.history().backfill({ limit: 1 })).processed).toBe(0)
    const window = { from: new Date("1984-01-06"), to: new Date("1984-01-07") }
    expect(await fixture.history().totals(window)).toMatchObject({ attempts: 2, tokensIn: 6 })
    expect(await fixture.history().coverage(window)).toMatchObject({
      legacy: true,
      incomplete: true,
      requestsBasis: "mixed-legacy",
    })
    expect(await fixture.db().select().from(usageRequestTerminals)).toHaveLength(0)
  })
  test("partial and hourly legacy views disclose unavailable day precision", async () => {
    const partial = { from: new Date("1984-01-05T12:00:00Z"), to: new Date("1984-01-05T18:00:00Z") }
    expect(await fixture.history().coverage(partial)).toMatchObject({
      legacy: true,
      incomplete: true,
      requestsBasis: "mixed-legacy",
    })
    expect(await fixture.history().totals(partial)).toMatchObject({ attempts: 0 })
    expect(await fixture.history().series(partial, "hour")).toHaveLength(0)
    expect(
      (await fixture.history().totals({ from: new Date("1984-01-05"), to: new Date("1984-01-06") }))
        .attempts,
    ).toBe(7)
  })
  test("set-based backfill is atomic above 2000 rows and preserves pending receipt facts", async () => {
    const rows = Array.from({ length: 2201 }, () =>
      historyAttempt({ createdAt: new Date("1984-01-09T12:00:00Z") }),
    )
    await fixture
      .db()
      .insert(usageRecords)
      .values(rows.map((row) => ({ ...row, ingestedAt: null })))
    const first = rows[0]
    if (!first) throw new Error("fixture absent")
    await fixture.usage().insertMany([first])
    const [held] = await fixture
      .db()
      .select()
      .from(usageContributions)
      .where(eq(usageContributions.id, first.id))
    expect(held?.source).toBe("legacy_pending")
    await fixture
      .get()
      .sql.unsafe(
        "create function fixture_backfill_failure() returns trigger language plpgsql as $$begin raise exception 'fixture backfill failure'; end$$",
      )
    await fixture
      .get()
      .sql.unsafe(
        "create trigger fixture_backfill_failure before insert on usage_contributions for each row execute function fixture_backfill_failure()",
      )
    try {
      await expect(fixture.history().backfill({ limit: 5000 })).rejects.toThrow()
      expect(
        await fixture
          .history()
          .totals({ from: new Date("1984-01-09"), to: new Date("1984-01-10") }),
      ).toMatchObject({ attempts: 0, tokensIn: 0 })
    } finally {
      await fixture.get().sql.unsafe("drop trigger fixture_backfill_failure on usage_contributions")
      await fixture.get().sql.unsafe("drop function fixture_backfill_failure()")
    }
    expect(await fixture.history().backfill({ limit: 5000 })).toEqual({
      processed: 2201,
      remaining: false,
    })
    const [accepted] = await fixture
      .db()
      .select()
      .from(usageContributions)
      .where(eq(usageContributions.id, first.id))
    expect(accepted).toMatchObject({
      source: "legacy_unbanked",
      payload: held?.payload,
      payloadHash: held?.payloadHash,
    })
    expect(
      await fixture.history().totals({ from: new Date("1984-01-09"), to: new Date("1984-01-10") }),
    ).toMatchObject({ attempts: 2201, requests: 0, tokensIn: 6603 })
    expect(await fixture.history().backfill({ limit: 5000 })).toEqual({
      processed: 0,
      remaining: false,
    })
  })
  test("event-clock sweep retries rollback/ack loss and revisits newly pending older rows after exhaustion", async () => {
    const oldest = historyAttempt({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      createdAt: new Date("1984-01-16T12:00:00Z"),
    })
    const later = historyAttempt({
      id: "00000000-0000-4000-8000-000000000018",
      createdAt: new Date("1984-01-18T12:00:00Z"),
    })
    await fixture
      .db()
      .insert(usageRecords)
      .values([
        { ...oldest, ingestedAt: null },
        { ...later, ingestedAt: null },
      ])
    const database = fixture.db(),
      wrapped = Object.create(database) as typeof database
    let loseAcknowledgment = false
    type Transaction = Parameters<Parameters<typeof database.transaction>[0]>[0]
    wrapped.transaction = async <T>(
      run: (tx: Transaction) => Promise<T>,
      config?: Parameters<typeof database.transaction>[1],
    ) => {
      const result = await database.transaction(run, config)
      if (loseAcknowledgment) {
        loseAcknowledgment = false
        throw Error("fixture commit acknowledgement lost")
      }
      return result
    }
    const maintenance = createUsageHistoryMaintenance(wrapped)
    await fixture
      .get()
      .sql.unsafe(
        "create function fixture_cursor_failure() returns trigger language plpgsql as $$begin raise exception 'fixture rollback'; end$$",
      )
    await fixture
      .get()
      .sql.unsafe(
        "create trigger fixture_cursor_failure before insert on usage_contributions for each row execute function fixture_cursor_failure()",
      )
    try {
      await expect(maintenance.backfill({ limit: 1 })).rejects.toThrow()
    } finally {
      await fixture.get().sql.unsafe("drop trigger fixture_cursor_failure on usage_contributions")
      await fixture.get().sql.unsafe("drop function fixture_cursor_failure()")
    }
    expect(
      await fixture
        .db()
        .select()
        .from(usageContributions)
        .where(eq(usageContributions.id, oldest.id)),
    ).toHaveLength(0)
    loseAcknowledgment = true
    await expect(maintenance.backfill({ limit: 1 })).rejects.toThrow("acknowledgement lost")
    expect(
      await fixture
        .db()
        .select()
        .from(usageContributions)
        .where(eq(usageContributions.id, oldest.id)),
    ).toHaveLength(1)
    expect(
      await fixture
        .db()
        .select()
        .from(usageContributions)
        .where(eq(usageContributions.id, later.id)),
    ).toHaveLength(0)
    expect(await maintenance.backfill({ limit: 1 })).toEqual({ processed: 1, remaining: true })
    const late = historyAttempt({ createdAt: new Date("1984-01-17T12:00:00Z") })
    await fixture
      .db()
      .insert(usageRecords)
      .values({ ...late, ingestedAt: null })
    await fixture.usage().insertMany([late])
    expect(await maintenance.backfill({ limit: 1 })).toEqual({ processed: 0, remaining: false })
    expect(await maintenance.backfill({ limit: 1 })).toEqual({ processed: 1, remaining: true })
    expect(await maintenance.backfill({ limit: 1 })).toEqual({ processed: 0, remaining: false })
    expect(
      await fixture.history().totals({ from: new Date("1984-01-16"), to: new Date("1984-01-19") }),
    ).toMatchObject({ attempts: 3, tokensIn: 9, requests: 0 })
  })
})
