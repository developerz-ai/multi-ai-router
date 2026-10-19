import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { usageHistoryState } from "../../src/schema/usage-history-state"
import { usageRecords } from "../../src/schema/usage-records"
import { historyAttempt, historyUrl, usageHistoryFixture } from "./usage-history-fixture"

const fixture = usageHistoryFixture()
const state = async () =>
  (await fixture.db().select().from(usageHistoryState).where(eq(usageHistoryState.id, "v2")))[0]
const clearWatermark = () =>
  fixture
    .db()
    .update(usageHistoryState)
    .set({ bankedThroughAt: null, bankedThroughId: null })
    .where(eq(usageHistoryState.id, "v2"))
const windows = [
  undefined,
  { from: new Date("1984-01-01"), to: new Date("1984-02-01") },
  { from: new Date("1984-01-03"), to: new Date("1984-01-04") },
  { from: new Date("1984-01-05T06:00:00Z"), to: new Date("1984-01-05T18:00:00Z") },
  { from: new Date("1990-01-01"), to: new Date("1990-02-01") },
]
/** coverage minus the clock, so two reads of the same data compare equal. */
const coverageOf = async (window: (typeof windows)[number]) => {
  const { dbNow: _now, ...rest } = await fixture.history().coverage(window)
  return rest
}
const rawPending = async (window: (typeof windows)[number]) => {
  const from = window?.from ?? new Date(0),
    to = window?.to ?? new Date("9999-01-01")
  const [row] = await fixture.get().sql.unsafe(
    `select exists(select 1 from usage_records r, (select coalesce(retention_before_day, '-infinity'::date) horizon from usage_history_state where id='v2') b
      where r.created_at >= greatest($1::timestamptz, b.horizon::timestamp at time zone 'UTC') and r.created_at < $2
      and not exists(select 1 from usage_contributions c where c.kind='attempt' and c.id=r.id and c.source<>'legacy_pending')) as pending`,
    [from.toISOString(), to.toISOString()],
  )
  return row?.pending as boolean
}

describe.skipIf(!historyUrl)("banked-through watermark (#275)", () => {
  test("pending is true before any proof, and a sweep that began without a cursor records the watermark", async () => {
    const rows = [
      historyAttempt({ createdAt: new Date("1984-01-05T12:00:00Z") }),
      historyAttempt({ createdAt: new Date("1984-01-02T12:00:00Z") }),
      historyAttempt({ createdAt: new Date("1984-01-05T12:00:00Z") }),
    ]
    await fixture
      .db()
      .insert(usageRecords)
      .values(rows.map((row) => ({ ...row, ingestedAt: null })))
    expect((await state())?.bankedThroughAt).toBeNull()
    expect(await rawPending(undefined)).toBe(true)
    // A resumed sweep (cursor set) that ends short proves nothing about rows before the cursor.
    // The resume cursor lives on one maintenance instance, so reuse it across the sweep.
    const sweeper = fixture.history()
    expect(await sweeper.backfill({ limit: 2 })).toEqual({ processed: 2, remaining: true })
    expect(await sweeper.backfill({ limit: 2 })).toEqual({ processed: 1, remaining: false })
    expect((await state())?.bankedThroughAt).toBeNull()
    // The next sweep starts from the beginning, finds nothing, and so proves the whole table clean.
    expect(await sweeper.backfill({ limit: 2 })).toEqual({ processed: 0, remaining: false })
    const [max] = await fixture
      .get()
      .sql.unsafe(
        `select created_at, id from usage_records order by created_at desc, id desc limit 1`,
      )
    const s = await state()
    expect(s?.bankedThroughAt?.toISOString()).toBe(
      new Date(max?.createdAt ?? max?.created_at).toISOString(),
    )
    expect(s?.bankedThroughId).toBe(max?.id)
    expect(await rawPending(undefined)).toBe(false)
  })
  test("coverage output is identical with and without the watermark, backdated rows included", async () => {
    // Backdated and future-dated rows admitted the way production writes them: contribution in the same transaction.
    await fixture.usage().insertBatch({
      attempts: [
        historyAttempt({ createdAt: new Date("1984-01-03T01:00:00Z") }),
        historyAttempt({ createdAt: new Date("1984-01-04T01:00:00Z") }),
      ],
      terminals: [],
    })
    await fixture.history().backfill({ limit: 1000 })
    expect((await state())?.bankedThroughAt).not.toBeNull()
    for (const window of windows) {
      const withWatermark = await coverageOf(window)
      expect(await rawPending(window)).toBe(false)
      const saved = await state()
      await clearWatermark()
      expect(await coverageOf(window)).toEqual(withWatermark)
      await fixture
        .db()
        .update(usageHistoryState)
        .set({ bankedThroughAt: saved?.bankedThroughAt, bankedThroughId: saved?.bankedThroughId })
        .where(eq(usageHistoryState.id, "v2"))
    }
  })
  test("a row after the watermark is pending whether the watermark is set or not", async () => {
    const late = historyAttempt({ createdAt: new Date("1985-06-01T00:00:00Z") })
    await fixture.db().insert(usageRecords).values(late)
    const window = { from: new Date("1985-01-01"), to: new Date("1986-01-01") }
    for (const w of [undefined, window]) {
      const withWatermark = await coverageOf(w)
      expect(withWatermark.incomplete).toBe(true)
      await clearWatermark()
      expect(await coverageOf(w)).toEqual(withWatermark)
      // restore for the next iteration
      await fixture.history().backfill({ limit: 1000 })
      await fixture.get().sql.unsafe(`delete from usage_contributions where id = '${late.id}'`)
      await fixture.history().backfill({ limit: 1000 })
      await fixture.history().backfill({ limit: 1000 })
    }
    await fixture.db().delete(usageRecords).where(eq(usageRecords.id, late.id))
  })
  test("retention deleting raw rows leaves the watermark valid and pending false", async () => {
    await fixture.history().backfill({ limit: 1000 })
    const before = await state()
    await fixture.usage().deleteOlderThan(new Date("1984-01-04"), 100)
    expect((await state())?.bankedThroughAt?.toISOString()).toBe(
      before?.bankedThroughAt?.toISOString(),
    )
    expect(await rawPending(undefined)).toBe(false)
    expect((await coverageOf(undefined)).requestsBasis).toBe(
      (
        await (async () => {
          await clearWatermark()
          return coverageOf(undefined)
        })()
      ).requestsBasis,
    )
  })
  test("the watermark never moves backward", async () => {
    await fixture.history().backfill({ limit: 1000 })
    const high = (await state())?.bankedThroughAt as Date
    await fixture.db().execute(sql`delete from usage_records`)
    await fixture.history().backfill({ limit: 1000 })
    expect((await state())?.bankedThroughAt?.getTime()).toBe(high.getTime())
  })
})
