import { beforeEach, describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createUsageReportRepository } from "../../src/repositories/usage-report-repository"
import { historyUrl, usageHistoryFixture } from "./usage-history-fixture"

/**
 * `usage_reports` against a real PostgreSQL: insert-once, new rows start `pending`, and the
 * retention sweep's boundary. The boundary matters because the floor is 14 days: just before
 * Monday 00:00 UTC the target week's `period_start` is almost exactly 14 days old, and a sweep
 * that rounded its cutoff up to a date would delete the row the task is about to regenerate.
 */
const fixture = usageHistoryFixture()
const DAY = 86_400_000

const input = (periodStart: string, payload: unknown = { n: periodStart }) => {
  const end = new Date(Date.parse(`${periodStart}T00:00:00Z`) + 7 * DAY)
  return {
    periodStart,
    periodEnd: end.toISOString().slice(0, 10),
    generatedAt: new Date("2026-10-12T00:30:00Z"),
    payload,
  }
}

describe.skipIf(!historyUrl)("the usage_reports repository", () => {
  test("a new report starts pending with no attempts and no delivery", async () => {
    const repo = createUsageReportRepository(fixture.db())
    expect(await repo.insertIfAbsent(input("2026-09-07"))).toBe(true)
    const row = await repo.findByPeriodStart("2026-09-07")
    expect(row).toMatchObject({
      periodStart: "2026-09-07",
      periodEnd: "2026-09-14",
      deliveryStatus: "pending",
      deliveryAttempts: 0,
      deliveredAt: null,
      lastError: null,
      payload: { n: "2026-09-07" },
    })
    expect(await repo.exists("2026-09-07")).toBe(true)
    expect(await repo.exists("2026-09-14")).toBe(false)
  })

  test("two generations that bypass the lock leave one row, and exactly one reports a write", async () => {
    const repo = createUsageReportRepository(fixture.db())
    const results = await Promise.all([
      repo.insertIfAbsent(input("2026-09-14", { by: "first" })),
      repo.insertIfAbsent(input("2026-09-14", { by: "second" })),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const [count] = await fixture
      .db()
      .execute<{ n: number }>(
        sql`select count(*)::int as n from usage_reports where period_start = '2026-09-14'`,
      )
    expect(count?.n).toBe(1)
  })

  test("list is newest week first and carries no payload", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-08-31"))
    const rows = await repo.list(10)
    expect(rows.map((r) => r.periodStart)).toEqual(["2026-09-14", "2026-09-07", "2026-08-31"])
    expect(Object.keys(rows[0] ?? {})).not.toContain("payload")
    expect((await repo.list(2)).map((r) => r.periodStart)).toEqual(["2026-09-14", "2026-09-07"])
  })

  test("delivery_status is a text column", async () => {
    const [column] = await fixture
      .db()
      .execute<{ data_type: string }>(
        sql`select data_type from information_schema.columns where table_name = 'usage_reports' and column_name = 'delivery_status'`,
      )
    expect(column?.data_type).toBe("text")
  })
})

/**
 * Delivery bookkeeping against a real PostgreSQL (issue #229). The claim is an optimistic version
 * check on (status, attempts), and every outcome write is conditional on the attempts value the
 * claim returned — so two concurrent deliverers post at most once, and the loser's write is a
 * no-op rather than a clobber.
 */
describe.skipIf(!historyUrl)("delivery claims and outcome writes", () => {
  beforeEach(async () => {
    await fixture.db().execute(sql`delete from usage_reports`)
  })

  test("a claim bumps attempts only when status and attempts match what the caller read", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-09-28"))
    expect(await repo.claimForDelivery("2026-09-28", "pending", 0)).toBe(1)
    // The same read values again: the row has moved on, so the claim misses and nothing changes.
    expect(await repo.claimForDelivery("2026-09-28", "pending", 0)).toBeUndefined()
    // The fresh read values claim again.
    expect(await repo.claimForDelivery("2026-09-28", "pending", 1)).toBe(2)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      deliveryStatus: "pending",
      deliveryAttempts: 2,
    })
  })

  test("a claim for an absent period misses", async () => {
    const repo = createUsageReportRepository(fixture.db())
    expect(await repo.claimForDelivery("2026-09-21", "pending", 0)).toBeUndefined()
  })

  test("markDelivered writes only for the claimed attempts, and clears the last error", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-09-28"))
    const claimed = await repo.claimForDelivery("2026-09-28", "pending", 0)
    expect(claimed).toBe(1)
    // A stale outcome write (wrong attempts value) changes nothing.
    const at = new Date("2026-10-05T01:00:00Z")
    expect(await repo.markDelivered("2026-09-28", 7, at)).toBe(false)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({ deliveryStatus: "pending" })
    // The right one transitions, stamps delivered_at and drops a previous failure reason.
    expect(await repo.markDelivered("2026-09-28", 1, at)).toBe(true)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      deliveryStatus: "sent",
      deliveryAttempts: 1,
      deliveredAt: at,
      lastError: null,
    })
  })

  test("markPendingFailed only transitions a pending row, once per claimed attempts", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-09-28"))
    const claimed = await repo.claimForDelivery("2026-09-28", "pending", 0)
    expect(claimed).toBe(1)
    expect(await repo.markPendingFailed("2026-09-28", 1, "webhook answered 503")).toBe(true)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      deliveryStatus: "failed",
      lastError: "webhook answered 503",
    })
    // The give-up transition is what a capture ties to: it must not happen twice.
    expect(await repo.markPendingFailed("2026-09-28", 1, "second writer")).toBe(false)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      lastError: "webhook answered 503",
    })
  })

  test("markFailed writes over any status for the claimed attempts — a re-send owns its outcome", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-09-28"))
    await repo.claimForDelivery("2026-09-28", "pending", 0)
    await repo.markDelivered("2026-09-28", 1, new Date("2026-10-05T01:00:00Z"))
    // Re-sending a sent row claims from (sent, 1); a failed re-send marks it failed whatever it was.
    const claimed = await repo.claimForDelivery("2026-09-28", "sent", 1)
    expect(claimed).toBe(2)
    expect(await repo.markFailed("2026-09-28", 2, "webhook answered 500")).toBe(true)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      deliveryStatus: "failed",
      deliveryAttempts: 2,
      lastError: "webhook answered 500",
    })
    // A stale attempts value still writes nothing.
    expect(await repo.markFailed("2026-09-28", 1, "late writer")).toBe(false)
  })

  test("recordNotConfigured writes pending-only or any-status, and never bumps attempts", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-09-28"))
    await repo.claimForDelivery("2026-09-28", "pending", 0)
    await repo.markDelivered("2026-09-28", 1, new Date("2026-10-05T01:00:00Z"))
    // The task's variant touches pending rows only: a sent week is never un-sent.
    expect(await repo.recordNotConfigured("2026-09-28", true)).toBe(false)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      deliveryStatus: "sent",
      deliveryAttempts: 1,
    })
    // The re-send's variant writes whatever the prior status was.
    expect(await repo.recordNotConfigured("2026-09-28", false)).toBe(true)
    expect(await repo.findByPeriodStart("2026-09-28")).toMatchObject({
      deliveryStatus: "not_configured",
      deliveryAttempts: 1,
    })
    // Idempotent: a row already not_configured is not "written" again.
    expect(await repo.recordNotConfigured("2026-09-28", false)).toBe(false)
    // And the task's variant flips a pending row.
    await repo.insertIfAbsent(input("2026-09-21"))
    expect(await repo.recordNotConfigured("2026-09-21", true)).toBe(true)
    expect(await repo.findByPeriodStart("2026-09-21")).toMatchObject({
      deliveryStatus: "not_configured",
      deliveryAttempts: 0,
    })
  })

  test("lastDeliveredAt is the newest delivered_at, or null when nothing was ever sent", async () => {
    const repo = createUsageReportRepository(fixture.db())
    expect(await repo.lastDeliveredAt()).toBeNull()
    await repo.insertIfAbsent(input("2026-09-21"))
    await repo.claimForDelivery("2026-09-21", "pending", 0)
    await repo.markDelivered("2026-09-21", 1, new Date("2026-09-28T01:00:00Z"))
    await repo.insertIfAbsent(input("2026-09-28"))
    await repo.claimForDelivery("2026-09-28", "pending", 0)
    await repo.markDelivered("2026-09-28", 1, new Date("2026-10-05T01:00:00Z"))
    expect(await repo.lastDeliveredAt()).toEqual(new Date("2026-10-05T01:00:00Z"))
  })
})

describe.skipIf(!historyUrl)("the retention sweep boundary", () => {
  /** What the janitor computes: the tick's clock minus the window, to the millisecond. */
  const cutoffAt = (now: Date, days: number) => new Date(now.getTime() - days * DAY)

  beforeEach(async () => {
    await fixture.db().execute(sql`delete from usage_reports`)
  })

  test("at Monday 00:00 UTC minus 1 s the target week's row is kept, and the older ones go", async () => {
    const repo = createUsageReportRepository(fixture.db())
    // At t = Mon 2026-10-19 00:00:00 minus 1 s the target week is 2026-10-05 .. 2026-10-12: its
    // period_start is 13 d 23 h 59 m 59 s old, one second inside the 14-day floor.
    for (const week of ["2026-09-21", "2026-09-28", "2026-10-05"])
      await repo.insertIfAbsent(input(week))
    const now = new Date("2026-10-18T23:59:59.000Z")
    expect(await repo.deleteOlderThan(cutoffAt(now, 14), 100)).toBe(2)
    expect(await repo.exists("2026-10-05")).toBe(true)
    expect(await repo.exists("2026-09-28")).toBe(false)
    expect(await repo.exists("2026-09-21")).toBe(false)
  })

  test("the comparison is strict: a row exactly at the cutoff stays", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-07-06"))
    // period_start 2026-07-06T00:00Z is exactly the cutoff.
    expect(await repo.deleteOlderThan(new Date("2026-07-06T00:00:00.000Z"), 100)).toBe(0)
    expect(await repo.exists("2026-07-06")).toBe(true)
    // One millisecond later it is older than the cutoff.
    expect(await repo.deleteOlderThan(new Date("2026-07-06T00:00:00.001Z"), 100)).toBe(1)
    expect(await repo.exists("2026-07-06")).toBe(false)
  })

  test("the cutoff is compared as an instant, not rounded to a date either way", async () => {
    const repo = createUsageReportRepository(fixture.db())
    await repo.insertIfAbsent(input("2026-06-08"))
    // A millisecond before the row's instant: nothing is older, whatever the rounding.
    expect(await repo.deleteOlderThan(new Date("2026-06-07T23:59:59.999Z"), 100)).toBe(0)
    expect(await repo.exists("2026-06-08")).toBe(true)
    // Mid-day on the row's own date: the row (midnight) is older than the cutoff instant.
    expect(await repo.deleteOlderThan(new Date("2026-06-08T12:00:00.000Z"), 100)).toBe(1)
  })

  test("a batch limit bounds one sweep, oldest first", async () => {
    const repo = createUsageReportRepository(fixture.db())
    for (const week of ["2025-01-06", "2025-01-13", "2025-01-20"])
      await repo.insertIfAbsent(input(week))
    expect(await repo.deleteOlderThan(new Date("2025-02-01T00:00:00Z"), 2)).toBe(2)
    expect(await repo.exists("2025-01-06")).toBe(false)
    expect(await repo.exists("2025-01-13")).toBe(false)
    expect(await repo.exists("2025-01-20")).toBe(true)
  })
})
