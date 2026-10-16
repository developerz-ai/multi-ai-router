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
      expect(refused({ ...tight, ...sunday, USAGE_REPORT_SETTLE_MINUTES: "54" }).variables).toEqual(
        ["USAGE_REPORT_SETTLE_MINUTES"],
      )
      const env = parseEnv({ ...base, ...tight, ...sunday, USAGE_REPORT_SETTLE_MINUTES: "53" })
      expect(env.usageReport.settleMinutes).toBe(53)
    })

    test("the default hourly check cannot fire in a 30 minute window", () => {
      const error = refused({ ...sunday, USAGE_REPORT_SETTLE_MINUTES: "30" })
      expect(error.variables).toEqual(["USAGE_REPORT_SETTLE_MINUTES"])
    })

    test("the jitter fraction widens the tick: a 95 minute window fits 60 minutes at 0 and not at 0.5", () => {
      // Saturday 23:00 plus 1405 minutes of settle leaves 1500 - 1405 = 95 minutes of the week.
      const window95 = {
        USAGE_REPORT_WEEKDAY: "6",
        USAGE_REPORT_HOUR_UTC: "23",
        USAGE_REPORT_SETTLE_MINUTES: "1405",
      }
      // 60 x 1 + 5 = 65 < 95: accepted. 60 x 1.5 + 5 = 95 >= 95: refused. The default tick
      // (60 x 1.2 + 5 = 77) fits the window, so the configured jitter closed it and the refusal
      // points at the interval, not at the schedule.
      expect(
        parseEnv({ ...base, ...window95, SCHEDULER_JITTER_FRACTION: "0" }).usageReport
          .settleMinutes,
      ).toBe(1405)
      expect(refused({ ...window95, SCHEDULER_JITTER_FRACTION: "0.5" }).variables).toEqual([
        "USAGE_REPORT_INTERVAL_MINUTES",
      ])
    })

    test("an interval too slow for a window the defaults fit is refused naming the interval", () => {
      // The same 95 minute window: 90 x 1.2 + 5 = 113 >= 95, while the default tick (77) fits.
      const window95 = {
        USAGE_REPORT_WEEKDAY: "6",
        USAGE_REPORT_HOUR_UTC: "23",
        USAGE_REPORT_SETTLE_MINUTES: "1405",
      }
      expect(refused({ ...window95, USAGE_REPORT_INTERVAL_MINUTES: "90" }).variables).toEqual([
        "USAGE_REPORT_INTERVAL_MINUTES",
      ])
    })

    test("the refusal rounds the displayed slowest tick, and the comparison stays unrounded", () => {
      // Interval 3 at jitter 0.25: the slowest tick is 3 x 1.25 + 5 = 8.75 minutes.
      const odd = {
        USAGE_REPORT_INTERVAL_MINUTES: "3",
        SCHEDULER_JITTER_FRACTION: "0.25",
        ...sunday,
      }
      // Settle 51 leaves 9 minutes: 8.75 < 9 fires, though the rounded 9 would not.
      expect(
        parseEnv({ ...base, ...odd, USAGE_REPORT_SETTLE_MINUTES: "51" }).usageReport.settleMinutes,
      ).toBe(51)
      // Settle 52 leaves 8: refused, and the message shows the tick as whole minutes.
      const error = refused({ ...odd, USAGE_REPORT_SETTLE_MINUTES: "52" })
      expect(error.message).toContain("= 9)")
      expect(error.message).not.toContain("8.75")
    })

    test("a refusal never displays a tick rounded onto the window itself (#258)", () => {
      // Interval 8 at jitter 0.05: the slowest tick is 8 x 1.05 + 5 = 13.4 minutes; settle 47
      // leaves a 13 minute window. Refused — and plain rounding would print "= 13" against
      // "leaving 13 minutes": a window refused for being equal to itself, hiding the fraction
      // that closed it. The display keeps the tenth instead.
      const error = refused({
        USAGE_REPORT_INTERVAL_MINUTES: "8",
        SCHEDULER_JITTER_FRACTION: "0.05",
        ...sunday,
        USAGE_REPORT_SETTLE_MINUTES: "47",
      })
      expect(error.message).toContain("leaving 13 minutes")
      expect(error.message).toContain("= 13.4)")
      expect(error.message).not.toContain("= 13)")

      // A tenth that still lands on the window (8 x 1.005 + 5 = 13.04, "13.0") reads equal too,
      // so the display rounds up: the operator sees a tick the window visibly fails to exceed.
      const collapsed = refused({
        USAGE_REPORT_INTERVAL_MINUTES: "8",
        SCHEDULER_JITTER_FRACTION: "0.005",
        ...sunday,
        USAGE_REPORT_SETTLE_MINUTES: "47",
      })
      expect(collapsed.message).toContain("= 14)")

      // A tick exactly equal to the window is refused for that equality — "13.0" against
      // "leaving 13 minutes" says the displayed equality is the real value, not a rounding.
      const exact = refused({
        USAGE_REPORT_INTERVAL_MINUTES: "8",
        SCHEDULER_JITTER_FRACTION: "0",
        ...sunday,
        USAGE_REPORT_SETTLE_MINUTES: "47",
      })
      expect(exact.message).toContain("= 13.0)")
    })
  })

  describe("USAGE_REPORT_INTERVAL_MINUTES and USAGE_REPORT_MAX_ROWS bounds", () => {
    test("the interval is bounded above by a day", () => {
      expect(
        parseEnv({ ...base, USAGE_REPORT_INTERVAL_MINUTES: "1440" }).scheduler
          .usageReportIntervalMinutes,
      ).toBe(1440)
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
