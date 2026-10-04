import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"
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
})
