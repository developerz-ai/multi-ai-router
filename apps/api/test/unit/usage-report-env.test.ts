import { describe, expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../src/config/env"

/** The weekly report's knobs: defaults, bounds, and the two refusals that would never fire or re-send. */

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}

function refused(over: Record<string, string>): EnvValidationError {
  try {
    parseEnv({ ...base, ...over })
  } catch (error) {
    if (error instanceof EnvValidationError) return error
    throw error
  }
  throw new Error("expected the environment to be refused")
}

describe("weekly report env", () => {
  test("defaults: Monday 00:00 UTC, 30 minute settle, hourly check, two years retained", () => {
    const env = parseEnv(base)
    expect(env.usageReport).toEqual({ weekday: 1, hourUtc: 0, settleMinutes: 30 })
    expect(env.scheduler.usageReportIntervalMinutes).toBe(60)
    expect(env.retention.usageReportsDays).toBe(730)
  })

  test("every knob is configurable", () => {
    const env = parseEnv({
      ...base,
      USAGE_REPORT_WEEKDAY: "5",
      USAGE_REPORT_HOUR_UTC: "17",
      USAGE_REPORT_SETTLE_MINUTES: "45",
      USAGE_REPORT_INTERVAL_MINUTES: "15",
      RETENTION_USAGE_REPORTS_DAYS: "400",
    })
    expect(env.usageReport).toEqual({ weekday: 5, hourUtc: 17, settleMinutes: 45 })
    expect(env.scheduler.usageReportIntervalMinutes).toBe(15)
    expect(env.retention.usageReportsDays).toBe(400)
  })

  describe("RETENTION_USAGE_REPORTS_DAYS", () => {
    test("refuses 13 by name, and says why", () => {
      const error = refused({ RETENTION_USAGE_REPORTS_DAYS: "13" })
      expect(error.variables).toEqual(["RETENTION_USAGE_REPORTS_DAYS"])
      expect(error.message).toContain("14")
    })

    test("accepts 14", () => {
      expect(parseEnv({ ...base, RETENTION_USAGE_REPORTS_DAYS: "14" }).retention.usageReportsDays).toBe(
        14,
      )
    })
  })

  describe("weekday and hour", () => {
    test.each(["0", "8", "monday", "-1"])("refuses weekday %p", (value) => {
      expect(refused({ USAGE_REPORT_WEEKDAY: value }).variables).toEqual(["USAGE_REPORT_WEEKDAY"])
    })

    test.each(["1", "7"])("accepts weekday %p", (value) => {
      expect(parseEnv({ ...base, USAGE_REPORT_WEEKDAY: value }).usageReport.weekday).toBe(
        Number(value),
      )
    })

    test("accepts hour 0 and 23, refuses 24", () => {
      expect(parseEnv({ ...base, USAGE_REPORT_HOUR_UTC: "0" }).usageReport.hourUtc).toBe(0)
      expect(parseEnv({ ...base, USAGE_REPORT_HOUR_UTC: "23" }).usageReport.hourUtc).toBe(23)
      expect(refused({ USAGE_REPORT_HOUR_UTC: "24" }).variables).toEqual(["USAGE_REPORT_HOUR_UTC"])
    })
  })

  describe("the combined anchor offset", () => {
    test("refuses an offset of a full week or more: the anchor would always fall after the next Monday", () => {
      // 6 d + 23 h + 60 min = 10080 minutes.
      const error = refused({
        USAGE_REPORT_WEEKDAY: "7",
        USAGE_REPORT_HOUR_UTC: "23",
        USAGE_REPORT_SETTLE_MINUTES: "60",
      })
      expect(error.variables).toEqual(["USAGE_REPORT_SETTLE_MINUTES"])
      expect(error.message).toContain("USAGE_REPORT_WEEKDAY")
      expect(error.message).toContain("USAGE_REPORT_HOUR_UTC")
    })

    test("accepts one minute less", () => {
      const env = parseEnv({
        ...base,
        USAGE_REPORT_WEEKDAY: "7",
        USAGE_REPORT_HOUR_UTC: "23",
        USAGE_REPORT_SETTLE_MINUTES: "59",
      })
      expect(env.usageReport.settleMinutes).toBe(59)
    })
  })
})
