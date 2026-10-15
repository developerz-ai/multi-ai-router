import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
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
const setSince = (day: string) => fixture.setUnpricedSince(day)
/** Every test owns its days and model names, so no test reads another's rows. */
const unknown = (
  model: string,
  at: string,
  over: Partial<Parameters<typeof historyAttempt>[0]> = {},
) =>
  historyAttempt({
    model,
    costBasis: "unknown",
    costEstimate: null,
    tokensIn: 10,
    tokensOut: 10,
    createdAt: new Date(at),
    ...over,
  })
const dailyRow = async (model: string) =>
  (await fixture.db().select().from(usageAttemptDailyV2)).find((row) => row.model === model)
const dayWindow = (from: string, to: string) => ({
  from: new Date(`${from}T00:00:00Z`),
  to: new Date(`${to}T00:00:00Z`),
})

describe.skipIf(!historyUrl)("unpriced attempts through the rollup and reads", () => {
  // Must stay first: later tests move unpriced_since, and this one reads what the migration seeded.
  test("a fresh database seeds unpriced_since to the day after the migration ran", async () => {
    const [state] = await fixture.db().select().from(usageHistoryState)
    const [expected] = await fixture
      .db()
      .execute<{ day: string }>(
        sql`select ((clock_timestamp() at time zone 'UTC')::date + 1)::text as day`,
      )
    expect(state?.unpricedSince).toBe(expected?.day as string)
  })

  test("a window wholly before unpriced_since reports null attempts, never 0", async () => {
    await setSince("2099-01-01")
    const totals = await fixture.history().totals(dayWindow("1984-01-01", "1984-02-01"))
    expect(totals.unpriced).toEqual({ attempts: null, since: "2099-01-01" })
  })

  test("a window ending exactly at since midnight is still wholly before it", async () => {
    await setSince("1984-04-05")
    await fixture
      .usage()
      .insertBatch({ attempts: [unknown("edge-model", "1984-04-04T12:00:00Z")], terminals: [] })
    // `to` is exclusive: [04-04, 04-05) never touches since's day, so it is not measured.
    const totals = await fixture.history().totals(dayWindow("1984-04-04", "1984-04-05"))
    expect(totals.unpriced.attempts).toBeNull()
    // One millisecond more reaches the first measured day.
    const reached = await fixture.history().totals({
      from: new Date("1984-04-04T00:00:00Z"),
      to: new Date("1984-04-05T00:00:00.001Z"),
    })
    expect(reached.unpriced.attempts).toBe(0)
  })

  test("a token-bearing unknown attempt counts 1; token-less failures and priced attempts add 0", async () => {
    const unpriced = unknown("unpriced-model", "1984-01-02T12:00:00Z", {
      tokensIn: 400,
      tokensOut: 100,
    })
    const failed = unknown("unpriced-model", "1984-01-02T12:00:00Z", {
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
    expect(await dailyRow("unpriced-model")).toMatchObject({
      attempts: 2,
      errors: 1,
      unpricedAttempts: 1,
      costMetered: "0.000000",
      costNotional: "0.000000",
    })
    expect(await dailyRow("priced-model")).toMatchObject({ unpricedAttempts: 0 })
    // Replaying the same contributions is idempotent at admission, and the table is untouched.
    expect(
      await write.insertBatch({ attempts: [unpriced, failed, priced], terminals: [] }),
    ).toEqual({ insertedAttempts: 0, insertedTerminals: 0 })
    expect((await dailyRow("unpriced-model"))?.unpricedAttempts).toBe(1)
    // And again at day repair.
    await fixture.history().rollupDay(new Date("1984-01-02T12:00:00Z"))
    expect((await dailyRow("unpriced-model"))?.unpricedAttempts).toBe(1)
  })

  test("separate batches on the same grain add: 1 then 2", async () => {
    const write = fixture.usage()
    await write.insertBatch({
      attempts: [unknown("additive-model", "1984-05-02T10:00:00Z")],
      terminals: [],
    })
    expect((await dailyRow("additive-model"))?.unpricedAttempts).toBe(1)
    await write.insertBatch({
      attempts: [unknown("additive-model", "1984-05-02T11:00:00Z")],
      terminals: [],
    })
    expect((await dailyRow("additive-model"))?.unpricedAttempts).toBe(2)
  })

  test("a measured batch on a pre-measure NULL row counts from 0, not NULL", async () => {
    await fixture
      .db()
      .insert(usageContributions)
      .values({
        id: crypto.randomUUID(),
        kind: "attempt",
        day: "1984-05-03",
        source: "live",
        payloadHash: "null-row-fixture",
        payload: {
          apiKeyId: null,
          accountId: null,
          poolId: null,
          model: "null-row-model",
          correlationId: crypto.randomUUID(),
          eventAt: "1984-05-03T09:00:00.000Z",
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
    await fixture.history().rollupDay(new Date("1984-05-03T12:00:00Z"))
    expect((await dailyRow("null-row-model"))?.unpricedAttempts).toBeNull()
    await fixture.usage().insertBatch({
      attempts: [unknown("null-row-model", "1984-05-03T12:00:00Z")],
      terminals: [],
    })
    expect(await dailyRow("null-row-model")).toMatchObject({ attempts: 2, unpricedAttempts: 1 })
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
    expect((await dailyRow("legacy-model"))?.unpricedAttempts).toBeNull()
  })

  test("measured days count through the daily table, the receipts query, and breakdown rows", async () => {
    await setSince("1984-02-10")
    await fixture.usage().insertBatch({
      attempts: [
        unknown("measured-model", "1984-02-10T12:00:00Z"),
        historyAttempt({
          model: "measured-priced",
          costBasis: "metered",
          costEstimate: "0.5",
          createdAt: new Date("1984-02-10T12:00:00Z"),
        }),
      ],
      terminals: [],
    })
    const window = dayWindow("1984-02-10", "1984-02-11")
    expect((await fixture.history().totals(window)).unpriced).toEqual({
      attempts: 1,
      since: "1984-02-10",
    })
    const groups = await fixture.history().breakdown(window, "model")
    expect(groups.find((row) => row.id === "measured-model")?.unpriced).toEqual({
      attempts: 1,
      since: "1984-02-10",
    })
    expect(groups.find((row) => row.id === "measured-priced")?.unpriced).toEqual({
      attempts: 0,
      since: "1984-02-10",
    })
    // A within-day window's days are all partial edges, so the receipts query alone serves it.
    const receiptsOnly = await fixture.history().totals({
      from: new Date("1984-02-10T12:00:00Z"),
      to: new Date("1984-02-10T14:00:00Z"),
    })
    expect(receiptsOnly.unpriced.attempts).toBe(1)
  })

  test("the receipts query only counts days on or after unpriced_since", async () => {
    await setSince("1984-06-03")
    await fixture.usage().insertBatch({
      attempts: [
        unknown("gate-model", "1984-06-02T18:00:00Z"),
        unknown("gate-model", "1984-06-03T06:00:00Z"),
      ],
      terminals: [],
    })
    // Both edges are partial days (no whole day inside the window), so receipts serve all of it.
    const totals = await fixture.history().totals({
      from: new Date("1984-06-02T12:00:00Z"),
      to: new Date("1984-06-03T12:00:00Z"),
    })
    expect(totals.attempts).toBe(2)
    expect(totals.unpriced.attempts).toBe(1)
  })

  test("a straddling window counts only measured days; a pre-since-only group reads 0", async () => {
    await setSince("1984-03-11")
    await fixture.usage().insertBatch({
      attempts: [
        unknown("pre-since-model", "1984-03-10T12:00:00Z"),
        unknown("post-since-model", "1984-03-11T12:00:00Z"),
      ],
      terminals: [],
    })
    const window = dayWindow("1984-03-09", "1984-03-13")
    expect((await fixture.history().totals(window)).unpriced.attempts).toBe(1)
    const groups = await fixture.history().breakdown(window, "model")
    expect(groups.find((row) => row.id === "pre-since-model")?.unpriced.attempts).toBe(0)
    expect(groups.find((row) => row.id === "post-since-model")?.unpriced.attempts).toBe(1)
  })
})
