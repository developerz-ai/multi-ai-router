import { describe, expect, test } from "bun:test"
import {
  formatCost,
  formatCount,
  formatDate,
  formatMillis,
  formatPercent,
  formatRelative,
  formatTimestamp,
  formatWindow,
  shortId,
} from "../../src/lib/format"

// Pure, and the clock is injected — `formatRelative(iso, nowMs)` never reads
// one. A locale is deliberately not pinned in the assertions that would depend
// on it.

describe("formatCount", () => {
  test("is exact below a thousand", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(934)).toBe("934")
  })

  test("compacts above it, without a trailing .0", () => {
    expect(formatCount(1200)).toBe("1.2k")
    expect(formatCount(18_000)).toBe("18k")
    expect(formatCount(2_400_000)).toBe("2.4M")
    expect(formatCount(3_000_000_000)).toBe("3B")
  })

  test("a non-finite count is a dash, never NaN on screen", () => {
    expect(formatCount(Number.NaN)).toBe("—")
  })
})

describe("formatCost", () => {
  test("never rounds a real spend down to zero", () => {
    expect(formatCost(0.0003)).toBe("$0.0003")
    expect(formatCost(0)).toBe("$0.00")
  })

  test("two decimals in the normal range", () => {
    expect(formatCost(12.345)).toBe("$12.35")
  })
})

describe("formatPercent", () => {
  test("a zero denominator is a dash, not a division", () => {
    expect(formatPercent(0, 0)).toBe("—")
  })

  test("small shares keep two decimals so they are not shown as 0%", () => {
    expect(formatPercent(1, 1000)).toBe("0.10%")
    expect(formatPercent(6, 100)).toBe("6.0%")
  })
})

describe("formatRelative", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z")

  test("null is 'never' — the honest answer for a key nobody used", () => {
    expect(formatRelative(null, now)).toBe("never")
  })

  test("past and future read differently", () => {
    expect(formatRelative("2026-07-24T11:00:00.000Z", now)).toBe("1h ago")
    expect(formatRelative("2026-07-24T14:00:00.000Z", now)).toBe("in 2h")
  })

  test("sub-minute collapses rather than counting seconds", () => {
    expect(formatRelative("2026-07-24T11:59:40.000Z", now)).toBe("just now")
  })

  test("days once it is past a day", () => {
    expect(formatRelative("2026-07-21T12:00:00.000Z", now)).toBe("3d ago")
  })

  test("an unparseable timestamp is a dash, not Invalid Date", () => {
    expect(formatRelative("not-a-date", now)).toBe("—")
  })
})

describe("formatWindow", () => {
  test("reads in the largest whole unit", () => {
    expect(formatWindow(60)).toBe("1m")
    expect(formatWindow(3600)).toBe("1h")
    expect(formatWindow(86_400)).toBe("24h")
    expect(formatWindow(90)).toBe("90s")
  })
})

describe("timestamps", () => {
  test("null and unparseable both render as a dash", () => {
    expect(formatTimestamp(null)).toBe("—")
    expect(formatTimestamp("nope")).toBe("—")
    expect(formatDate(null)).toBe("—")
  })

  test("a valid ISO instant renders as something", () => {
    expect(formatTimestamp("2026-07-24T12:00:00.000Z").length).toBeGreaterThan(0)
  })
})

describe("shortId", () => {
  test("truncates with an ellipsis, and leaves short ids alone", () => {
    expect(shortId("abcd")).toBe("abcd")
    expect(shortId("0123456789abcdef")).toBe("01234567…")
  })
})

describe("formatMillis", () => {
  // "A null reading renders as an explicitly unread track, never as zero" — the console's own
  // rule. "0 ms" on the overhead tile is a perfect score nobody measured.
  test("null is a dash, never 0 ms", () => {
    expect(formatMillis(null)).toBe("—")
    expect(formatMillis(Number.NaN)).toBe("—")
  })

  test("a real reading keeps its unit, and zero measured is still a reading", () => {
    expect(formatMillis(0)).toBe("0 ms")
    expect(formatMillis(3.4)).toBe("3 ms")
    expect(formatMillis(2100)).toBe("2100 ms")
  })
})
