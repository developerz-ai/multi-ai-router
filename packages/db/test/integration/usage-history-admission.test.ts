import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { usageContributions } from "../../src/schema/usage-contributions"
import { usageRecords } from "../../src/schema/usage-records"
import { usageRequestTerminals } from "../../src/schema/usage-request-terminals"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

const fixture = usageHistoryFixture()
describe.skipIf(!historyUrl)("idempotent event-time history admission", () => {
  test("failover and midnight settlement produce three attempts and one winning terminal", async () => {
    const a = historyAttempt({
      accountId: crypto.randomUUID(),
      poolId: crypto.randomUUID(),
      outcome: "upstream_error",
      createdAt: new Date("1984-01-02T23:59:59Z"),
    })
    const b = historyAttempt({
      accountId: crypto.randomUUID(),
      correlationId: a.correlationId,
      outcome: "upstream_error",
    })
    const c = historyAttempt({
      accountId: crypto.randomUUID(),
      correlationId: a.correlationId,
      createdAt: new Date("1984-01-03T00:00:01Z"),
    })
    const terminal = historyTerminal(a, { outcome: "upstream_error", responseStatus: 503 })
    const write = fixture.usage()
    expect(await write.insertBatch({ attempts: [a, b, c], terminals: [terminal] })).toEqual({
      insertedAttempts: 3,
      insertedTerminals: 1,
    })
    const before = await fixture.history().totals(fixture.window)
    expect(before).toMatchObject({ requests: 1, attempts: 3, errors: 2, tokensIn: 9 })
    const groups = await fixture.history().breakdown(fixture.window, "accountId")
    expect(groups.find((row) => row.id === a.accountId)).toMatchObject({ requests: 1, attempts: 1 })
    expect(groups.find((row) => row.id === c.accountId)).toMatchObject({ requests: 0, attempts: 1 })
    await write.deleteOlderThan(new Date("1984-01-04"), 10)
    expect(await write.insertBatch({ attempts: [a, b, c], terminals: [terminal] })).toEqual({
      insertedAttempts: 0,
      insertedTerminals: 0,
    })
    expect(await fixture.history().totals(fixture.window)).toEqual(before)
    expect(await fixture.db().select().from(usageRecords)).toHaveLength(0)
    expect(await fixture.db().select().from(usageRequestTerminals)).toHaveLength(0)
    const series = await fixture.history().series(fixture.window, "day")
    expect(series.reduce((sum, row) => sum + row.requests, 0)).toBe(1)
    expect(series.find((row) => row.at === "1984-01-03T00:00:00.000Z")).toMatchObject({
      requests: 1,
    })
  })
  test("late event after raw purge remains in its application day, independent of DB ingestion", async () => {
    const row = historyAttempt({ createdAt: new Date("1984-01-10T12:34:00Z") })
    const prior = await fixture.history().totals(fixture.window)
    await fixture.usage().insertMany([row])
    const [persisted] = await fixture
      .db()
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, row.id))
    if (row.createdAt === undefined) throw Error("fixture event time absent")
    expect(persisted?.createdAt.toISOString()).toBe(row.createdAt.toISOString())
    expect(persisted?.ingestedAt?.getTime()).toBeGreaterThan(new Date("2020-01-01").getTime())
    await fixture.usage().deleteOlderThan(new Date("1984-01-11"), 10)
    await fixture.usage().insertMany([row])
    const total = await fixture.history().totals(fixture.window)
    expect(total.attempts).toBe(prior.attempts + 1)
    const partial = await fixture
      .history()
      .totals({ from: new Date("1984-01-10T12:00:00Z"), to: new Date("1984-01-10T13:00:00Z") })
    expect(partial.attempts).toBe(1)
  })
  test("real overflow aborts raw, terminal, receipt and additive deltas atomically", async () => {
    const before = await fixture.history().totals(fixture.window)
    const valid = historyAttempt(),
      bad = historyAttempt({ tokensIn: 2147483648 })
    await expect(
      fixture.usage().insertBatch({ attempts: [valid, bad], terminals: [historyTerminal(valid)] }),
    ).rejects.toThrow()
    expect(
      await fixture
        .db()
        .select()
        .from(usageContributions)
        .where(eq(usageContributions.id, valid.id)),
    ).toHaveLength(0)
    expect(
      await fixture.db().select().from(usageRecords).where(eq(usageRecords.id, valid.id)),
    ).toHaveLength(0)
    expect(await fixture.history().totals(fixture.window)).toEqual(before)
    await expect(
      fixture.usage().insertBatch({
        attempts: [valid],
        terminals: [historyTerminal(valid, { responseStatus: 40000 })],
      }),
    ).rejects.toThrow()
    expect(
      await fixture.db().select().from(usageRecords).where(eq(usageRecords.id, valid.id)),
    ).toHaveLength(0)
  })
  test("conflicting replay does not alter committed facts", async () => {
    const row = historyAttempt()
    await fixture.usage().insertMany([row])
    await expect(fixture.usage().insertMany([{ ...row, tokensIn: 99 }])).rejects.toThrow(
      "immutable usage identity",
    )
  })
  test("terminal batches beyond one Bind statement commit once and later-chunk failure rolls back", async () => {
    const attempt = historyAttempt({ createdAt: new Date("1984-01-20T12:00:00Z") })
    const terminals = Array.from({ length: 4500 }, () =>
      historyTerminal(attempt, {
        correlationId: crypto.randomUUID(),
        winnerEventId: null,
        attributionKind: "unstarted",
        settledAt: new Date("1984-01-20T12:00:00Z"),
      }),
    )
    const write = fixture.usage(),
      window = { from: new Date("1984-01-20"), to: new Date("1984-01-21") }
    expect(await write.insertBatch({ attempts: [], terminals })).toEqual({
      insertedAttempts: 0,
      insertedTerminals: 4500,
    })
    expect((await fixture.history().totals(window)).requests).toBe(4500)
    expect(await write.insertBatch({ attempts: [], terminals })).toEqual({
      insertedAttempts: 0,
      insertedTerminals: 0,
    })
    const invalid = terminals.map((terminal) => ({
      ...terminal,
      correlationId: crypto.randomUUID(),
    }))
    const last = invalid.at(-1)
    if (last === undefined) throw Error("fixture terminal absent")
    last.responseStatus = 40000
    await expect(write.insertBatch({ attempts: [attempt], terminals: invalid })).rejects.toThrow()
    expect((await fixture.history().totals(window)).requests).toBe(4500)
    expect(
      await fixture.db().select().from(usageRecords).where(eq(usageRecords.id, attempt.id)),
    ).toHaveLength(0)
    const first = invalid[0]
    if (first === undefined) throw Error("fixture terminal absent")
    expect(
      await fixture
        .db()
        .select()
        .from(usageRequestTerminals)
        .where(eq(usageRequestTerminals.correlationId, first.correlationId)),
    ).toHaveLength(0)
  })
})
