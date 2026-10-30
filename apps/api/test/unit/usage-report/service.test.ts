import { describe, expect, test } from "bun:test"
import { type UsageReportRepository, UsageWeekRowCeilingError } from "@multi-ai-router/db"
import { USAGE_REPORT_MAX_ROWS_CEILING } from "../../../src/config/usage-report"
import { createUsageReportService } from "../../../src/services/usage-report"

/**
 * The too-large failure's wording. Below the hard cap there is a knob to raise, and the message
 * says so; at the cap (100000, the most `USAGE_REPORT_MAX_ROWS` accepts) there is nothing left to
 * raise, and a message that suggests raising anyway sends the operator to a setting that will be
 * refused at boot. No database: the week read is stubbed at the ceiling error.
 */

const NOW = new Date("2026-10-14T12:00:00.000Z")
const WEEK = { start: new Date("2026-10-05T00:00:00Z"), end: new Date("2026-10-12T00:00:00Z") }

const idleReports: UsageReportRepository = {
  insertIfAbsent: async () => false,
  exists: async () => false,
  findByPeriodStart: async () => undefined,
  list: async () => [],
  deleteOlderThan: async () => 0,
}

function serviceAt(maxRows: number) {
  return createUsageReportService({
    reports: idleReports,
    history: {
      weekRows: async (_window, ceiling) => {
        throw new UsageWeekRowCeilingError(ceiling)
      },
    },
    labels: async () => ({ keys: new Map() }),
    pools: async () => [],
    upstreamTimeoutMs: 600_000,
    upstreamStreamTimeoutMs: 600_000,
    listLimit: 10,
    maxRows,
    now: () => NOW,
  })
}

describe("the too-large failure", () => {
  test("below the cap it says to raise USAGE_REPORT_MAX_ROWS and names the cap", async () => {
    const preview = await serviceAt(1).preview()
    expect(preview.ok).toBe(false)
    if (!preview.ok) {
      expect(preview.failure.code).toBe("report_too_large")
      expect(preview.failure.message).toContain("raise USAGE_REPORT_MAX_ROWS")
      expect(preview.failure.message).toContain(String(USAGE_REPORT_MAX_ROWS_CEILING))
    }
  })

  test("at the cap it says a code change is needed, not a raise", async () => {
    const preview = await serviceAt(USAGE_REPORT_MAX_ROWS_CEILING).preview()
    expect(preview.ok).toBe(false)
    if (!preview.ok) {
      expect(preview.failure.code).toBe("report_too_large")
      expect(preview.failure.message).not.toContain("raise USAGE_REPORT_MAX_ROWS")
      expect(preview.failure.message).toContain("code change")
      expect(preview.failure.message).toContain(String(USAGE_REPORT_MAX_ROWS_CEILING))
    }
  })

  test("generate rejects with the same at-cap wording the preview answers", async () => {
    const error = await serviceAt(USAGE_REPORT_MAX_ROWS_CEILING)
      .generate(WEEK, NOW)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("code change")
    expect((error as Error).message).not.toContain("raise USAGE_REPORT_MAX_ROWS")
  })
})

/**
 * A streamed attempt may run `UPSTREAM_STREAM_TIMEOUT_MS` (1 h default), far past the 10 min
 * `UPSTREAM_TIMEOUT_MS`. The settle-margin caveat compares the real gap after the week boundary with
 * the longest an attempt can run, so a report generated 30 min after the boundary must not claim
 * every in-flight attempt had landed.
 */
describe("settle margin against the longest upstream attempt", () => {
  const thirtyMinutesPast = new Date("2026-10-12T00:30:00.000Z")
  function service(upstreamStreamTimeoutMs: number) {
    return createUsageReportService({
      reports: idleReports,
      history: { weekRows: async () => ({ rows: [], unpricedSince: "infinity" }) },
      labels: async () => ({ keys: new Map() }),
      pools: async () => [],
      upstreamTimeoutMs: 600_000,
      upstreamStreamTimeoutMs,
      listLimit: 10,
      maxRows: 10,
      now: () => thirtyMinutesPast,
    })
  }

  test("a 1 h stream deadline is not covered by a 30 min gap", async () => {
    const preview = await service(3_600_000).preview()
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.coverage.upstreamTimeoutMs).toBe(3_600_000)
    expect(preview.value.coverage.settleCoversUpstreamTimeout).toBe(false)
    const text = preview.value.caveats.find((c) => c.code === "settle_margin")?.text ?? ""
    expect(text).toContain("60 minute")
  })

  test("the non-streamed deadline still decides when it is the longer one", async () => {
    const preview = await service(60_000).preview()
    expect(preview.ok && preview.value.coverage.upstreamTimeoutMs).toBe(600_000)
    expect(preview.ok && preview.value.coverage.settleCoversUpstreamTimeout).toBe(true)
  })
})
