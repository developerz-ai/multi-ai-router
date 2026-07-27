import { describe, expect, test } from "bun:test"
import { fromDateTimeInput, toDateTimeInput } from "../../src/lib/datetime-input"

/**
 * The control speaks local wall time and the API speaks ISO-8601 with an offset.
 * Every assertion here is written so it holds in **any** timezone the suite runs
 * in — asserting a literal string would only prove the machine's own offset, and
 * the bug this guards against is precisely one that hides at UTC+0.
 */
describe("datetime-input", () => {
  test("round-trips an instant back to the same minute", () => {
    const iso = "2026-08-01T16:00:00.000Z"
    expect(fromDateTimeInput(toDateTimeInput(iso))).toBe(iso)
  })

  test("round-trips a whole year of instants, so no offset or DST edge drifts one", () => {
    const start = Date.parse("2026-01-01T00:07:00.000Z")
    for (let day = 0; day < 365; day += 1) {
      const iso = new Date(start + day * 86_400_000).toISOString()
      expect(fromDateTimeInput(toDateTimeInput(iso))).toBe(iso)
    }
  })

  test("renders the control's own shape — minutes, no seconds, no zone", () => {
    expect(toDateTimeInput("2026-08-01T16:00:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  test("never expires is an empty box, in both directions", () => {
    expect(toDateTimeInput(null)).toBe("")
    expect(fromDateTimeInput("")).toBeNull()
    expect(fromDateTimeInput("   ")).toBeNull()
  })

  test("a value neither side can read is empty, never a wrong instant", () => {
    expect(toDateTimeInput("not-a-date")).toBe("")
    expect(fromDateTimeInput("not-a-date")).toBeNull()
  })

  test("reads the box as local wall time, not as UTC", () => {
    // The whole point of the module: `new Date("…T18:00")` is the operator's 18:00, so the
    // instant it names differs from the same string read as UTC by exactly the local offset.
    const iso = fromDateTimeInput("2026-08-01T18:00")
    expect(iso).not.toBeNull()
    const drift = Date.parse(iso ?? "") - Date.parse("2026-08-01T18:00:00.000Z")
    expect(drift).toBe(new Date("2026-08-01T18:00").getTimezoneOffset() * 60_000)
  })
})
