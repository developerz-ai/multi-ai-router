import { describe, expect, test } from "bun:test"
import { anchorOffsetMinutes } from "../../../src/config/usage-report"
import {
  isoDay,
  lastCompleteWeek,
  parseReportWeek,
  reportAnchor,
} from "../../../src/services/usage-report/period"

/**
 * The week arithmetic behind the weekly report. `getUTCDay()` counts Sunday as 0, so every
 * boundary a Monday-based week can get wrong is pinned here: the last second of Sunday, Monday
 * itself, and the anchor plus or minus a millisecond.
 */
const MONDAY = new Date("2026-10-12T00:00:00.000Z")

describe("lastCompleteWeek", () => {
  test("Sunday 23:59:59.999 targets the week that ended on the previous Monday", () => {
    const week = lastCompleteWeek(new Date("2026-10-18T23:59:59.999Z"))
    expect(isoDay(week.start)).toBe("2026-10-05")
    expect(isoDay(week.end)).toBe("2026-10-12")
  })

  test("Monday 00:00:00.000 targets the week that has just ended", () => {
    const week = lastCompleteWeek(new Date("2026-10-19T00:00:00.000Z"))
    expect(isoDay(week.start)).toBe("2026-10-12")
    expect(isoDay(week.end)).toBe("2026-10-19")
  })

  test("a Thursday targets the week that ended the Monday before", () => {
    const week = lastCompleteWeek(new Date("2026-10-15T08:00:00.000Z"))
    expect(isoDay(week.start)).toBe("2026-10-05")
    expect(isoDay(week.end)).toBe("2026-10-12")
  })
})

describe("reportAnchor", () => {
  const offset = 30 * 60_000

  test("is the latest Monday 00:00 UTC plus the offset", () => {
    expect(reportAnchor(new Date("2026-10-15T08:00:00.000Z"), offset).toISOString()).toBe(
      "2026-10-12T00:30:00.000Z",
    )
  })

  test("on a Sunday it is still that week's Monday", () => {
    expect(reportAnchor(new Date("2026-10-18T23:59:59.999Z"), offset).toISOString()).toBe(
      "2026-10-12T00:30:00.000Z",
    )
  })

  test("at Monday 00:00:00.000 exactly it moves to the new Monday", () => {
    expect(reportAnchor(new Date("2026-10-19T00:00:00.000Z"), offset).toISOString()).toBe(
      "2026-10-19T00:30:00.000Z",
    )
  })
})

describe("anchorOffsetMinutes", () => {
  test("is (weekday - 1) days plus the hour plus the settle margin", () => {
    expect(anchorOffsetMinutes({ weekday: 1, hourUtc: 0, settleMinutes: 30 })).toBe(30)
    expect(anchorOffsetMinutes({ weekday: 3, hourUtc: 9, settleMinutes: 30 })).toBe(
      2 * 1440 + 9 * 60 + 30,
    )
    expect(anchorOffsetMinutes({ weekday: 7, hourUtc: 23, settleMinutes: 59 })).toBe(10079)
  })
})

describe("parseReportWeek", () => {
  test("accepts a Monday", () => {
    expect(parseReportWeek("2026-10-12")?.toISOString()).toBe(MONDAY.toISOString())
  })

  test.each([
    "2026-10-13",
    "2026-10-18",
    "2026-10-12T00:00:00Z",
    "2026-1-12",
    "20261012",
    "nope",
    "",
    "2026-02-30",
    "2026-13-01",
  ])("refuses %p", (input) => {
    expect(parseReportWeek(input)).toBeUndefined()
  })
})
