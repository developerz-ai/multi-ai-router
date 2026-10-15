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
    expect(env.usageReport).toEqual({ weekday: 1, hourUtc: 0, settleMinutes: 30, maxRows: 50_000 })
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
      USAGE_REPORT_MAX_ROWS: "2000",
    })
    expect(env.usageReport).toEqual({ weekday: 5, hourUtc: 17, settleMinutes: 45, maxRows: 2_000 })
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
      expect(
        parseEnv({ ...base, RETENTION_USAGE_REPORTS_DAYS: "14" }).retention.usageReportsDays,
      ).toBe(14)
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

  describe("the firing window", () => {
    // The window is the time between the anchor and the end of the week: the report is only
    // generated if a tick lands in it. A tick can be as late as interval * (1 + jitter), and the
    // reader keeps a 5 minute margin for the tick's own work. Interval 1 and jitter 0 make the
    // arithmetic exact: the window must exceed 1 + 5 = 6 minutes.
    const tight = { USAGE_REPORT_INTERVAL_MINUTES: "1", SCHEDULER_JITTER_FRACTION: "0" }
    const sunday = { USAGE_REPORT_WEEKDAY: "7", USAGE_REPORT_HOUR_UTC: "23" }

    test("the defaults pass", () => {
      expect(() => parseEnv(base)).not.toThrow()
    })

    test("refuses an offset of a full week or more: the anchor would always fall after the next Monday", () => {
      // 6 d + 23 h + 60 min = 10080 minutes.
      const error = refused({ ...sunday, USAGE_REPORT_SETTLE_MINUTES: "60" })
      expect(error.variables).toEqual(["USAGE_REPORT_SETTLE_MINUTES"])
      expect(error.message).toContain("USAGE_REPORT_WEEKDAY")
      expect(error.message).toContain("USAGE_REPORT_HOUR_UTC")
      expect(error.message).toContain("USAGE_REPORT_INTERVAL_MINUTES")
    })

    test("refuses a window not longer than one jittered tick plus margin, accepts one minute more", () => {
      // settle 54 leaves 6 minutes (1 + 5 >= 6: refused); settle 53 leaves 7 (accepted).
      expect(
        refused({ ...tight, ...sunday, USAGE_REPORT_SETTLE_MINUTES: "54" }).variables,
      ).toEqual(["USAGE_REPORT_SETTLE_MINUTES"])
      const env = parseEnv({ ...base, ...tight, ...sunday, USAGE_REPORT_SETTLE_MINUTES: "53" })
      expect(env.usageReport.settleMinutes).toBe(53)
    })

    test("the default hourly check cannot fire in a 30 minute window", () => {
      const error = refused({ ...sunday, USAGE_REPORT_SETTLE_MINUTES: "30" })
      expect(error.variables).toEqual(["USAGE_REPORT_SETTLE_MINUTES"])
    })

    test("the jitter fraction widens the tick: 60 minutes at 0.5 is 90", () => {
      // Window of 100 minutes: fine at jitter 0 (60 + 5), refused at 0.5 (90 + 5 < 100 is fine, so use 95).
      const settle = String(10080 - 8640 - 1380 - 95)
      expect(
        parseEnv({ ...base, ...sunday, USAGE_REPORT_SETTLE_MINUTES: settle, SCHEDULER_JITTER_FRACTION: "0" })
          .usageReport.settleMinutes,
      ).toBe(Number(settle))
      expect(
        refused({ ...sunday, USAGE_REPORT_SETTLE_MINUTES: settle, SCHEDULER_JITTER_FRACTION: "0.5" })
          .variables,
      ).toEqual(["USAGE_REPORT_SETTLE_MINUTES"])
    })
  })

  describe("USAGE_REPORT_INTERVAL_MINUTES and USAGE_REPORT_MAX_ROWS bounds", () => {
    test("the interval is bounded above by a day", () => {
      expect(parseEnv({ ...base, USAGE_REPORT_INTERVAL_MINUTES: "1440" }).scheduler.usageReportIntervalMinutes).toBe(1440)
      expect(refused({ USAGE_REPORT_INTERVAL_MINUTES: "1441" }).variables).toEqual([
        "USAGE_REPORT_INTERVAL_MINUTES",
      ])
    })

    test("the row ceiling is positive and at most 100000", () => {
      expect(refused({ USAGE_REPORT_MAX_ROWS: "0" }).variables).toEqual(["USAGE_REPORT_MAX_ROWS"])
      expect(refused({ USAGE_REPORT_MAX_ROWS: "100001" }).variables).toEqual([
        "USAGE_REPORT_MAX_ROWS",
      ])
      expect(parseEnv({ ...base, USAGE_REPORT_MAX_ROWS: "100000" }).usageReport.maxRows).toBe(
        100_000,
      )
    })
  })
})
