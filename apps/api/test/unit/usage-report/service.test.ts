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
