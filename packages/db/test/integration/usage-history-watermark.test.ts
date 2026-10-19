import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { createUsageHistoryRepository } from "../../src/repositories/usage-history-repository"
import { usageHistoryState } from "../../src/schema/usage-history-state"
import { usageRecords } from "../../src/schema/usage-records"
import { historyAttempt, historyUrl, usageHistoryFixture } from "./usage-history-fixture"

const fixture = usageHistoryFixture()
const LOW = "00000000-0000-0000-0000-000000000001"
const HIGH = "ffffffff-ffff-ffff-ffff-ffffffffffff"
const at = (iso: string) => new Date(iso)
const day = (d: string) => ({ from: at(`${d}T00:00:00Z`), to: at(`${d}T23:59:59Z`) })

const state = async () =>
  (await fixture.db().select().from(usageHistoryState).where(eq(usageHistoryState.id, "v2")))[0]
const setWatermark = (when: Date | null, id: string | null) =>
  fixture
    .db()
    .update(usageHistoryState)
    .set({ bankedThroughAt: when, bankedThroughId: id })
    .where(eq(usageHistoryState.id, "v2"))
/** Every test seeds its own world: no rows, no rollups, no watermark, no retention horizon. */
const reset = async () => {
  await fixture
    .get()
    .sql.unsafe(
      "truncate usage_records, usage_contributions, usage_daily, usage_attempt_daily_v2, usage_request_daily_v2, usage_request_terminals",
    )
  await fixture.db().insert(usageHistoryState).values({ id: "v2" }).onConflictDoNothing()
  await fixture
    .db()
    .update(usageHistoryState)
    .set({ bankedThroughAt: null, bankedThroughId: null, retentionBeforeDay: null })
    .where(eq(usageHistoryState.id, "v2"))
}
/** The way production writes: the contribution is admitted in the same transaction. */
const admit = (createdAt: string, id?: string) =>
  fixture.usage().insertBatch({
    attempts: [historyAttempt({ createdAt: at(createdAt), ...(id ? { id } : {}) })],
    terminals: [],
  })
/** A write that bypasses admission: a raw row with no contribution. */
const rawInsert = (createdAt: string, id: string) =>
  fixture
    .db()
    .insert(usageRecords)
    .values(historyAttempt({ createdAt: at(createdAt), id }))
/** The raw-delete guard silently keeps unbanked rows, so a test that removes one lifts it first. */
const removeRaw = async (id: string) => {
  const { sql } = fixture.get()
  await sql.unsafe("alter table usage_records disable trigger usage_history_raw_delete_guard")
  try {
    await fixture.db().delete(usageRecords).where(eq(usageRecords.id, id))
  } finally {
    await sql.unsafe("alter table usage_records enable trigger usage_history_raw_delete_guard")
  }
}
/** A cursorless sweep short of its limit: the only thing that may advance the watermark. */
const sweep = () => fixture.history().backfill({ limit: 1000 })

type Window = { from: Date; to: Date } | undefined
const coverageOf = async (window: Window) => {
  const { dbNow: _now, ...rest } = await fixture.history().coverage(window)
  return rest
}
/** Coverage with W as stored, asserted equal to coverage with W cleared, then W restored. */
const coverageBothWays = async (window: Window) => {
  const saved = await state()
  const withW = await coverageOf(window)
  await setWatermark(null, null)
  const without = await coverageOf(window)
  await setWatermark(saved?.bankedThroughAt ?? null, saved?.bankedThroughId ?? null)
  expect(without).toEqual(withW)
  return withW
}

describe.skipIf(!historyUrl)("banked-through watermark (#275)", () => {
  test("a resumed sweep never certifies the table; the next cursorless one does", async () => {
    await reset()
    await fixture
      .db()
      .insert(usageRecords)
      .values(
        [
          historyAttempt({ createdAt: at("1984-01-05T12:00:00Z") }),
          historyAttempt({ createdAt: at("1984-01-02T12:00:00Z") }),
          historyAttempt({ createdAt: at("1984-01-05T12:00:00Z") }),
        ].map((row) => ({ ...row, ingestedAt: null })),
      )
    expect((await state())?.bankedThroughAt).toBeNull()
    // The resume cursor lives on one maintenance instance, so reuse it across the sweep.
    const sweeper = fixture.history()
    expect(await sweeper.backfill({ limit: 2 })).toEqual({ processed: 2, remaining: true })
    expect(await sweeper.backfill({ limit: 2 })).toEqual({ processed: 1, remaining: false })
    expect((await state())?.bankedThroughAt).toBeNull() // resumed, short: proves nothing before the cursor
    expect(await sweeper.backfill({ limit: 2 })).toEqual({ processed: 0, remaining: false })
    const [max] = await fixture
      .get()
      .sql.unsafe(
        `select created_at as "at", id from usage_records order by created_at desc, id desc limit 1`,
      )
    const s = await state()
    expect(s?.bankedThroughAt?.toISOString()).toBe(new Date(max?.at).toISOString())
    expect(s?.bankedThroughId).toBe(max?.id)
  })

  test("pending is decided by the (created_at, id) position after W, and W changes no answer", async () => {
    await reset()
    await admit("1984-01-05T12:00:00Z", LOW)
    await sweep()
    expect((await state())?.bankedThroughAt?.toISOString()).toBe("1984-01-05T12:00:00.000Z")
    expect((await state())?.bankedThroughId).toBe(LOW)
    // Legacy-free baseline: pending is the only signal that can raise `incomplete`.
    expect(await coverageBothWays(undefined)).toMatchObject({
      legacy: false,
      incomplete: false,
      requestsBasis: "terminal",
    })

    // (a) an unbanked row strictly after W
    const after = crypto.randomUUID()
    await rawInsert("1984-01-06T08:00:00Z", after)
    for (const w of [undefined, day("1984-01-06")])
      expect(await coverageBothWays(w)).toMatchObject({
        legacy: false,
        incomplete: true,
        requestsBasis: "mixed-legacy",
      })
    await removeRaw(after)
    expect((await coverageOf(undefined)).incomplete).toBe(false)

    // (b) an unbanked row at W.created_at whose id sorts after W.id
    await rawInsert("1984-01-05T12:00:00Z", HIGH)
    for (const w of [undefined, day("1984-01-05")])
      expect(await coverageBothWays(w)).toMatchObject({
        legacy: false,
        incomplete: true,
        requestsBasis: "mixed-legacy",
      })
    await removeRaw(HIGH)

    // (c) a backdated row admitted below W is banked by its own transaction, never pending
    await admit("1984-01-02T09:00:00Z")
    expect(await coverageBothWays(undefined)).toMatchObject({ legacy: false, incomplete: false })
    expect(await coverageBothWays(day("1984-01-02"))).toMatchObject({
      legacy: false,
      incomplete: false,
    })
  })

  test("OUT OF CONTRACT: a raw unbanked row below W is under-reported until the next full sweep", async () => {
    await reset()
    await admit("1984-01-05T12:00:00Z", LOW)
    await sweep()
    const stray = crypto.randomUUID()
    await rawInsert("1984-01-03T00:00:00Z", stray) // bypasses admission, lands below W
    expect((await coverageOf(undefined)).incomplete).toBe(false) // the documented under-report
    await setWatermark(null, null) // the remedy
    expect((await coverageOf(undefined)).incomplete).toBe(true)
    await sweep() // a full sweep adopts it
    expect((await coverageOf(undefined)).incomplete).toBe(true) // adopted as legacy_overlap: disclosed as legacy
    expect((await coverageOf(undefined)).legacy).toBe(true)
  })

  test("a sweep that adopts a legacy_overlap row does not certify the table", async () => {
    await reset()
    await admit("1984-01-05T12:00:00Z", LOW)
    await sweep()
    const before = await state()
    await rawInsert("1984-01-07T00:00:00Z", crypto.randomUUID()) // ingested_at set, no contribution
    expect(await sweep()).toMatchObject({ processed: 1 })
    expect((await state())?.bankedThroughAt?.getTime()).toBe(before?.bankedThroughAt?.getTime())
    expect((await state())?.bankedThroughId).toBe(before?.bankedThroughId)
  })

  test("the watermark never moves backward", async () => {
    await reset()
    await admit("1984-01-02T00:00:00Z")
    const newest = crypto.randomUUID()
    await admit("1984-01-09T00:00:00Z", newest)
    await sweep()
    const high = (await state())?.bankedThroughAt
    expect(high?.toISOString()).toBe("1984-01-09T00:00:00.000Z")
    await removeRaw(newest) // table max is now older than W: the guard is what holds W
    await sweep()
    expect((await state())?.bankedThroughAt?.getTime()).toBe(high?.getTime())
    expect((await state())?.bankedThroughId).toBe(newest)
  })

  test("retention deleting raw rows leaves W valid and pending false", async () => {
    await reset()
    await admit("1984-01-02T00:00:00Z")
    await admit("1984-01-08T00:00:00Z")
    await sweep()
    const before = await state()
    expect(before?.bankedThroughAt?.toISOString()).toBe("1984-01-08T00:00:00.000Z")
    expect(await fixture.usage().deleteOlderThan(at("1984-01-04"), 100)).toBeGreaterThan(0)
    expect((await state())?.bankedThroughAt?.getTime()).toBe(before?.bankedThroughAt?.getTime())
    expect(await coverageBothWays(undefined)).toMatchObject({ incomplete: false })
  })

  test("the table refuses a half-set pair, by the named CHECK", async () => {
    await reset()
    for (const [when, id] of [
      [at("1984-01-01T00:00:00Z"), null],
      [null, LOW],
    ] as const) {
      // Drizzle wraps the driver error; the constraint violation is on `.cause`.
      const error = await setWatermark(when, id).then(
        () => undefined,
        (e: unknown) => e,
      )
      const cause = (error as { cause?: { code?: string; constraint_name?: string } } | undefined)
        ?.cause
      expect(cause?.code).toBe("23514")
      expect(cause?.constraint_name).toBe("usage_history_state_watermark_paired")
    }
  })

  test("the pending check scans only rows after W (the perf property, not just the answer)", async () => {
    await reset()
    const rows = 300
    await fixture.usage().insertBatch({
      attempts: Array.from({ length: rows }, (_, i) =>
        historyAttempt({ createdAt: new Date(Date.UTC(1984, 0, 2, 0, i)) }),
      ),
      terminals: [],
    })
    await sweep()
    expect((await state())?.bankedThroughAt).not.toBeNull()
    // Capture the real statement `coverage` issues for `pending`, instead of restating it here.
    const captured: { sql: string; params: unknown[] }[] = []
    const real = fixture.db()
    const recording = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "execute") return Reflect.get(target, prop, receiver)
        return (query: Parameters<typeof real.execute>[0]) => {
          captured.push(new PgDialect().sqlToQuery(query))
          return real.execute(query)
        }
      },
    })
    await createUsageHistoryRepository(recording).coverage()
    const pending = captured.find((q) => q.sql.includes("as pending"))
    expect(pending).toBeDefined()
    const scanned = await fixture.get().sql.begin(async (tx) => {
      // A tiny fixture would otherwise pick a seq scan whatever the predicate allows.
      await tx.unsafe("set local enable_seqscan = off")
      const plan = await tx.unsafe(
        `explain (analyze, format json) ${pending?.sql}`,
        (pending?.params ?? []) as never[],
      )
      const nodes: Record<string, unknown>[] = []
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node)
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child)
      }
      walk(
        (plan[0]?.["QUERY PLAN"] as { Plan: Record<string, unknown> }[] | undefined)?.[0]?.Plan ??
          {},
      )
      // Every node reading `usage_records` under the `pending` alias, rows it actually produced.
      const reads = nodes.filter((n) => n["Relation Name"] === "usage_records" && n.Alias === "r")
      expect(reads.length).toBeGreaterThan(0)
      return reads.reduce(
        (sum, n) => sum + Number(n["Actual Rows"]) * Number(n["Actual Loops"] ?? 1),
        0,
      )
    })
    // Floor in place: only the row(s) at W are read. Without it the scan walks all 300.
    expect(scanned).toBeLessThan(10)
  })
})
