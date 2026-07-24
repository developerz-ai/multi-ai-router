import { describe, expect, test } from "bun:test"
import { resolveWindow } from "../../../src/services/usage-read"
import { buildAxis, densify } from "../../../src/services/usage-read/axis"

/**
 * The chart axis.
 *
 * The property under test is that a quiet bucket is a **zero, not a gap**. Aggregate queries
 * return only buckets that had traffic; plotting those directly draws a sparkline that never dips,
 * because the empty hours simply are not there. Every row's series is also plotted on the same
 * axis, which is what makes two rows in a breakdown comparable at a glance.
 */

const NOW = new Date("2026-03-15T14:30:00.000Z")

describe("buildAxis", () => {
  test("hourly buckets start on the hour and run to now", () => {
    const axis = buildAxis(resolveWindow({ window: "today" }, NOW))

    expect(axis[0]).toBe("2026-03-15T00:00:00.000Z")
    // 00:00 through 14:00 inclusive — the current, incomplete hour is a point, not an omission.
    expect(axis).toHaveLength(15)
    expect(axis.at(-1)).toBe("2026-03-15T14:00:00.000Z")
  })

  test("a daily window is one point per day", () => {
    expect(buildAxis(resolveWindow({ window: "7d" }, NOW))).toHaveLength(8)
  })

  test("a lifetime window is capped rather than returning tens of thousands of points", () => {
    const axis = buildAxis(resolveWindow({ window: "lifetime" }, NOW))

    // Epoch to now in days is far past anything a sparkline can render honestly.
    expect(axis.length).toBeLessThanOrEqual(400)
    expect(axis.length).toBeGreaterThan(0)
  })

  test("a window shorter than one bucket still gets a bucket", () => {
    const axis = buildAxis(
      resolveWindow({ from: "2026-03-15T14:10:00.000Z", to: "2026-03-15T14:20:00.000Z" }, NOW),
    )

    // Otherwise the chart is empty for the first hour of every deployment.
    expect(axis).toEqual(["2026-03-15T14:00:00.000Z"])
  })
})

describe("densify", () => {
  test("a bucket with no traffic is zero, not missing", () => {
    const axis = [
      "2026-03-15T12:00:00.000Z",
      "2026-03-15T13:00:00.000Z",
      "2026-03-15T14:00:00.000Z",
    ]
    const points = new Map([["2026-03-15T14:00:00.000Z", 7]])

    expect(densify(axis, points)).toEqual([0, 0, 7])
  })

  test("the result is always the axis length, so two rows line up", () => {
    const axis = ["a", "b", "c"]

    expect(densify(axis, new Map())).toEqual([0, 0, 0])
    // A point off the axis is dropped, never appended: a longer series would break the alignment
    // that is the entire reason a shared axis exists.
    expect(densify(axis, new Map([["z", 9]]))).toHaveLength(3)
  })
})
