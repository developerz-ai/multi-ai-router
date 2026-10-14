import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { usageAttemptDailyV2 } from "../../src/schema/usage-aggregate-v2"
import { usageContributions } from "../../src/schema/usage-contributions"
import { usageHistoryState } from "../../src/schema/usage-history-state"
import { historyAttempt, historyUrl, usageHistoryFixture } from "./usage-history-fixture"

/**
 * The unpriced-attempts measure, storage to read: one per unknown-basis attempt that used tokens,
 * NULL for anything written before the measure existed, and null (never 0) for windows that
 * predate measurement entirely.
 */

const fixture = usageHistoryFixture()
const setSince = async (day: string) =>
  fixture
    .db()
    .update(usageHistoryState)
    .set({ unpricedSince: day })
    .where(eq(usageHistoryState.id, "v2"))

describe.skipIf(!historyUrl)("unpriced attempts through the rollup and reads", () => {
  test("a fresh database gets a non-null unpriced_since from the migration", async () => {
    const [state] = await fixture.db().select().from(usageHistoryState)
    expect(state?.unpricedSince).toEqual(expect.any(String))
    expect(state.unpricedSince >= new Date().toISOString().slice(0, 10)).toBe(true)
  })

  test("a window wholly before unpriced_since reports null attempts, never 0", async () => {
    const totals = await fixture.history().totals(fixture.window)
    expect(totals.unpriced.attempts).toBeNull()
    expect(totals.unpriced.since > "1984-02-01").toBe(true)
  })

  test("a token-bearing unknown attempt counts 1; token-less failures and priced attempts add 0", async () => {
    const unpriced = historyAttempt({
      model: "unpriced-model",
      costBasis: "unknown",
      costEstimate: null,
      tokensIn: 400,
      tokensOut: 100,
    })
    const failed = historyAttempt({
      model: "unpriced-model",
      costBasis: "unknown",
      costEstimate: null,
      tokensIn: 0,
      tokensOut: 0,
      outcome: "upstream_error",
    })
    const priced = historyAttempt({
      model: "priced-model",
      costBasis: "metered",
      costEstimate: "0.500000",
    })
    const write = fixture.usage()
    await write.insertBatch({ attempts: [unpriced, failed, priced], terminals: [] })
    const rows = await fixture.db().select().from(usageAttemptDailyV2)
    const unknownRow = rows.find((row) => row.model === "unpriced-model")
    expect(unknownRow).toMatchObject({
      attempts: 2,
      errors: 1,
      unpricedAttempts: 1,
      costMetered: "0.000000",
      costNotional: "0.000000",
    })
    expect(rows.find((row) => row.model === "priced-model")).toMatchObject({
      unpricedAttempts: 0,
    })
    // Replaying the same contributions is idempotent, at admission and at day repair.
    expect(
      await write.insertBatch({ attempts: [unpriced, failed, priced], terminals: [] }),
    ).toEqual({ insertedAttempts: 0, insertedTerminals: 0 })
    await fixture.history().rollupDay(new Date("1984-01-02T12:00:00Z"))
    const repaired = await fixture.db().select().from(usageAttemptDailyV2)
    expect(repaired.find((row) => row.model === "unpriced-model")?.unpricedAttempts).toBe(1)
  })

  test("repairing a day whose contributions predate the migration leaves the measure NULL", async () => {
    await fixture
      .db()
      .insert(usageContributions)
      .values({
        id: crypto.randomUUID(),
        kind: "attempt",
        day: "1984-01-06",
        source: "live",
        payloadHash: "pre-measure-fixture",
        payload: {
          apiKeyId: null,
          accountId: null,
          poolId: null,
          model: "legacy-model",
          correlationId: crypto.randomUUID(),
          eventAt: "1984-01-06T12:00:00.000Z",
          attempts: 1,
          requests: 0,
          errors: 0,
          tokensIn: 5,
          tokensOut: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMetered: "0",
          costNotional: "0",
        },
      })
    expect(await fixture.history().rollupDay(new Date("1984-01-06T12:00:00Z"))).toBe(1)
    const [row] = await fixture
      .db()
      .select()
      .from(usageAttemptDailyV2)
      .where(eq(usageAttemptDailyV2.day, "1984-01-06"))
    expect(row?.unpricedAttempts).toBeNull()
  })

  test("measured days count through the daily table, the receipts query, and breakdown rows", async () => {
    await setSince("1984-01-01")
    const attempt = historyAttempt({
      model: "measured-model",
      costBasis: "unknown",
      costEstimate: null,
      tokensIn: 10,
      tokensOut: 10,
      createdAt: new Date("1984-01-02T12:00:00Z"),
    })
    await fixture.usage().insertBatch({ attempts: [attempt], terminals: [] })
    const totals = await fixture.history().totals(fixture.window)
    // 2 = this attempt + the token-bearing unpriced-model attempt the earlier test left on the
    // same day of this shared fixture database (the failed and priced ones add 0).
    expect(totals.unpriced).toEqual({ attempts: 2, since: "1984-01-01" })
    const groups = await fixture.history().breakdown(fixture.window, "model")
    expect(groups.find((row) => row.id === "measured-model")?.unpriced).toEqual({
      attempts: 1,
      since: "1984-01-01",
    })
    expect(groups.find((row) => row.id === "unpriced-model")?.unpriced.attempts).toBe(1)
    expect(groups.find((row) => row.id === "priced-model")?.unpriced).toEqual({
      attempts: 0,
      since: "1984-01-01",
    })
    // A within-day window's days are all partial edges, so the receipts query alone serves it.
    const receiptsOnly = await fixture.history().totals({
      from: new Date("1984-01-02T12:00:00Z"),
      to: new Date("1984-01-02T14:00:00Z"),
    })
    expect(receiptsOnly.unpriced.attempts).toBe(2)
  })

  test("a straddling window counts only measured days; a pre-since-only group reads 0", async () => {
    await setSince("1984-01-03")
    const before = historyAttempt({
      model: "pre-since-model",
      costBasis: "unknown",
      costEstimate: null,
      tokensIn: 5,
      tokensOut: 5,
      createdAt: new Date("1984-01-02T12:00:00Z"),
    })
    const after = historyAttempt({
      model: "post-since-model",
      costBasis: "unknown",
      costEstimate: null,
      tokensIn: 5,
      tokensOut: 5,
      createdAt: new Date("1984-01-03T12:00:00Z"),
    })
    await fixture.usage().insertBatch({ attempts: [before, after], terminals: [] })
    const window = { from: new Date("1984-01-01"), to: new Date("1984-01-05") }
    expect((await fixture.history().totals(window)).unpriced.attempts).toBe(1)
    const groups = await fixture.history().breakdown(window, "model")
    expect(groups.find((row) => row.id === "pre-since-model")?.unpriced.attempts).toBe(0)
    expect(groups.find((row) => row.id === "post-since-model")?.unpriced.attempts).toBe(1)
  })
})
