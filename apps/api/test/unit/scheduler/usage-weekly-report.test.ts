import { describe, expect, test } from "bun:test"
import type { UsageReportRow } from "@multi-ai-router/db"
import { createScheduler } from "../../../src/scheduler"
import { createUsageWeeklyReportTask } from "../../../src/scheduler/tasks/usage-weekly-report"
import { createReportDeliveryService } from "../../../src/services/usage-report/delivery"
import { isoDay } from "../../../src/services/usage-report/period"
import {
  auditSpy,
  captureSpy,
  expectNoWebhookLeak,
  memoryReportStore,
  reportRow,
  STUB_WEBHOOK_URL,
  type StubOutcome,
  webhookStub,
} from "../../support/report-delivery"
import { alwaysContended, alwaysFree, clock, memoryTaskRepository, silentLogger } from "./fixtures"

/**
 * The weekly report task against an injected clock and an in-memory report store. The store
 * implements the same two-method seam the real service does: `exists` and `generate`, where
 * `generate` answers whether it wrote a row (a conflict answers false, like
 * `ON CONFLICT (period_start) DO NOTHING`).
 */
const MINUTE = 60_000
// Mon 2026-10-12, 00:00 UTC.
const MONDAY = new Date("2026-10-12T00:00:00.000Z")
const at = (iso: string) => new Date(iso)

function store() {
  const days = new Set<string>()
  const generated: { start: string; end: string; at: string }[] = []
  return {
    days,
    generated,
    exists: async (periodStart: string) => days.has(periodStart),
    generate: async (week: { start: Date; end: Date }, now: Date) => {
      const start = isoDay(week.start)
      if (days.has(start)) return false
      days.add(start)
      generated.push({ start, end: isoDay(week.end), at: now.toISOString() })
      return true
    },
  }
}

function harness(
  offset: { weekday: number; hour: number; settle: number } = { weekday: 1, hour: 0, settle: 30 },
  lock: "free" | "contended" = "free",
) {
  const reports = store()
  const driven = clock(MONDAY)
  const task = createUsageWeeklyReportTask({
    reports,
    anchorOffsetMs: ((offset.weekday - 1) * 1440 + offset.hour * 60 + offset.settle) * MINUTE,
    intervalMs: 60 * MINUTE,
  })
  const scheduler = createScheduler({
    tasks: [task],
    repo: memoryTaskRepository(),
    logger: silentLogger(),
    lock: lock === "free" ? alwaysFree() : alwaysContended(),
    jitterFraction: 0,
    now: driven.now,
  })
  const tickAt = async (iso: string) => {
    driven.advance(at(iso).getTime() - driven.now().getTime())
    return scheduler.runNow("usage_weekly_report")
  }
  return { reports, tickAt }
}

describe("the weekly report task", () => {
  test("is named for its scheduled_task enum value", () => {
    const task = createUsageWeeklyReportTask({
      reports: store(),
      anchorOffsetMs: 30 * MINUTE,
      intervalMs: 60 * MINUTE,
    })
    expect(task.name).toBe("usage_weekly_report")
  })

  test("before the anchor nothing happens; at the anchor exactly one row is written", async () => {
    const { reports, tickAt } = harness()
    const early = await tickAt("2026-10-12T00:29:59.999Z")
    expect(early.status).toBe("success")
    expect(early.itemsProcessed).toBe(0)
    expect(reports.generated).toHaveLength(0)

    const due = await tickAt("2026-10-12T00:30:00.000Z")
    expect(due.itemsProcessed).toBe(1)
    expect(reports.generated).toEqual([
      { start: "2026-10-05", end: "2026-10-12", at: "2026-10-12T00:30:00.000Z" },
    ])
  })

  test("a second tick produces nothing", async () => {
    const { reports, tickAt } = harness()
    await tickAt("2026-10-12T00:30:00.000Z")
    const again = await tickAt("2026-10-12T01:30:00.000Z")
    expect(again.itemsProcessed).toBe(0)
    expect(reports.generated).toHaveLength(1)
  })

  test("a second replica, with the lock held elsewhere, produces nothing", async () => {
    const { reports, tickAt } = harness(undefined, "contended")
    const result = await tickAt("2026-10-12T05:00:00.000Z")
    expect(result.status).toBe("skipped_locked")
    expect(reports.generated).toHaveLength(0)
  })

  test("three missed weeks produce one late report, for the latest complete week", async () => {
    const { reports, tickAt } = harness()
    // Nothing has run for three weeks; the router comes back on a Wednesday.
    await tickAt("2026-11-04T12:00:00.000Z")
    expect(reports.generated).toEqual([
      { start: "2026-10-26", end: "2026-11-02", at: "2026-11-04T12:00:00.000Z" },
    ])
    const again = await tickAt("2026-11-04T13:00:00.000Z")
    expect(again.itemsProcessed).toBe(0)
    expect(reports.generated).toHaveLength(1)
  })

  test("Sunday 23:59:59.999 still targets the week that ended the previous Monday", async () => {
    const { reports, tickAt } = harness()
    await tickAt("2026-10-18T23:59:59.999Z")
    expect(reports.generated.map((g) => g.start)).toEqual(["2026-10-05"])
  })

  test("a row for the target week that already exists is never regenerated", async () => {
    const { reports, tickAt } = harness()
    reports.days.add("2026-10-05")
    const result = await tickAt("2026-10-15T10:00:00.000Z")
    expect(result.itemsProcessed).toBe(0)
    expect(reports.generated).toHaveLength(0)
  })

  test("a non-default weekday and hour move the anchor: Wednesday 09:00 plus 30 min", async () => {
    const { reports, tickAt } = harness({ weekday: 3, hour: 9, settle: 30 })
    await tickAt("2026-10-14T09:29:59.999Z")
    expect(reports.generated).toHaveLength(0)
    await tickAt("2026-10-14T09:30:00.000Z")
    expect(reports.generated.map((g) => g.start)).toEqual(["2026-10-05"])
  })
})

/**
 * Delivery rides the same task (issue #229): the real delivery service over the in-memory store
 * double and the scripted webhook stub, driven by the scheduler clock. `stored: false` leaves the
 * generation half live too, so one tick can generate and deliver.
 */
function deliveryHarness(
  opts: {
    readonly outcomes?: readonly StubOutcome[]
    readonly webhookUrl?: string | null
    readonly maxDeliveryAttempts?: number
    readonly rows?: readonly UsageReportRow[]
    readonly stored?: boolean
  } = {},
) {
  const stub = webhookStub(...(opts.outcomes ?? []))
  const spy = captureSpy()
  const rows = memoryReportStore(...(opts.rows ?? [reportRow()]))
  const delivery = createReportDeliveryService({
    store: rows,
    audit: auditSpy().audit,
    webhookUrl: opts.webhookUrl === undefined ? STUB_WEBHOOK_URL : opts.webhookUrl,
    maxDeliveryAttempts: opts.maxDeliveryAttempts ?? 6,
    publicUrl: null,
    timeoutMs: 1_000,
    now: () => at("2026-10-12T00:30:00.000Z"),
    fetchImpl: stub.fetchImpl,
    capture: spy.capture,
  })
  const reports = store()
  if (opts.stored !== false) reports.days.add("2026-10-05")
  const driven = clock(MONDAY)
  const scheduler = createScheduler({
    tasks: [
      createUsageWeeklyReportTask({
        reports,
        anchorOffsetMs: 30 * MINUTE,
        intervalMs: 60 * MINUTE,
        delivery,
      }),
    ],
    repo: memoryTaskRepository(),
    logger: silentLogger(),
    lock: alwaysFree(),
    jitterFraction: 0,
    now: driven.now,
  })
  const tickAt = async (iso: string) => {
    driven.advance(at(iso).getTime() - driven.now().getTime())
    return scheduler.runNow("usage_weekly_report")
  }
  return { stub, captured: spy.events, rows: rows.rows, reports, tickAt }
}

describe("the weekly report task — delivery", () => {
  test("posts only the latest period: older pending and not_configured rows never revive", async () => {
    const h = deliveryHarness({
      rows: [
        reportRow("2026-08-31", { deliveryStatus: "not_configured" }),
        reportRow("2026-09-07", { deliveryStatus: "not_configured" }),
        reportRow("2026-09-14"),
        reportRow("2026-09-21"),
        reportRow("2026-09-28"),
        reportRow("2026-10-05"),
      ],
    })
    const result = await h.tickAt("2026-10-12T00:30:00.000Z")
    expect(result.status).toBe("success")
    expect(result.itemsProcessed).toBe(1)
    expect(h.stub.requests).toHaveLength(1)
    expect(h.rows.get("2026-10-05")?.deliveryStatus).toBe("sent")
    for (const period of ["2026-09-14", "2026-09-21", "2026-09-28"]) {
      expect(h.rows.get(period)).toMatchObject({ deliveryStatus: "pending", deliveryAttempts: 0 })
    }
    for (const period of ["2026-08-31", "2026-09-07"]) {
      expect(h.rows.get(period)?.deliveryStatus).toBe("not_configured")
    }
  })

  test("a freshly generated report is delivered in the same tick", async () => {
    const h = deliveryHarness({ stored: false })
    const result = await h.tickAt("2026-10-12T00:30:00.000Z")
    expect(result.status).toBe("success")
    // One for the stored row, one for the delivered post.
    expect(result.itemsProcessed).toBe(2)
    expect(h.reports.generated.map((g) => g.start)).toEqual(["2026-10-05"])
    expect(h.stub.requests).toHaveLength(1)
    expect(h.rows.get("2026-10-05")?.deliveryStatus).toBe("sent")
  })

  test("a retryable answer rides the next tick and then sends, uncaptured", async () => {
    const h = deliveryHarness({ outcomes: [{ status: 503 }, { status: 204 }] })
    const first = await h.tickAt("2026-10-12T00:30:00.000Z")
    expect(first.status).toBe("success")
    expect(first.itemsProcessed).toBe(0)
    const second = await h.tickAt("2026-10-12T01:30:00.000Z")
    expect(second.itemsProcessed).toBe(1)
    expect(h.stub.requests).toHaveLength(2)
    expect(h.rows.get("2026-10-05")?.deliveryStatus).toBe("sent")
    expect(h.captured).toHaveLength(0)
  })

  test("a give-up fails the task outcome with the scrubbed reason; later ticks skip", async () => {
    const h = deliveryHarness({ outcomes: [{ status: 500 }], maxDeliveryAttempts: 1 })
    const result = await h.tickAt("2026-10-12T00:30:00.000Z")
    expect(result.status).toBe("failed")
    expect(result.error).toBe("discord webhook answered 500")
    expectNoWebhookLeak(result.error ?? "")
    expect(h.rows.get("2026-10-05")?.deliveryStatus).toBe("failed")
    expect(h.captured).toHaveLength(1)
    const after = await h.tickAt("2026-10-12T01:30:00.000Z")
    expect(after.status).toBe("success")
    expect(after.itemsProcessed).toBe(0)
    expect(h.stub.requests).toHaveLength(1)
    expect(h.captured).toHaveLength(1)
  })

  test("an unset webhook records not_configured and makes no request", async () => {
    const h = deliveryHarness({ webhookUrl: null })
    const result = await h.tickAt("2026-10-12T00:30:00.000Z")
    expect(result.status).toBe("success")
    expect(result.itemsProcessed).toBe(0)
    expect(h.stub.requests).toHaveLength(0)
    expect(h.rows.get("2026-10-05")?.deliveryStatus).toBe("not_configured")
    expect(h.captured).toHaveLength(0)
  })
})
