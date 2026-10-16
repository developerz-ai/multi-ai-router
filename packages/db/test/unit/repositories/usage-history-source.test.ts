import { describe, expect, test } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import { historySource } from "../../../src/repositories/usage-history-source"
import type { UsageWindow } from "../../../src/repositories/usage-read-repository"

/**
 * The contributions branch of the facts source reads the durable receipts for the window's partial
 * day edges. Its `day` column is indexed; its event-time filter is not. Before this fix the start
 * edge (`day < first`) had no lower bound, so `usage_contributions_day_idx` walked every day back to
 * the retention horizon — ~255k index entries on prod for a 30-day window — before the event-time
 * filter threw the rows away. The day range `[startDay, endDay]` is a no-op on the result (every
 * admitted receipt's event-time already lies in `[from, to)`, so its `day` already lies in the
 * range) but keeps the scan to the two days the window actually touches.
 *
 * Shape, not timing: the assertion is that the generated SQL carries the bound. No database.
 */

const render = (window: UsageWindow, hourly: boolean) =>
  new PgDialect().sqlToQuery(historySource(window, hourly, {}))

// A 30-day window with a mid-day start, exactly the prod fingerprint from issue #250.
const from = new Date("2026-09-16T18:42:00.000Z")
const to = new Date("2026-10-16T18:42:00.000Z")
const window: UsageWindow = { from, to }

describe("historySource contributions day bound", () => {
  test("daily mode bounds the receipts scan to the window's days, both edges", () => {
    const { sql, params } = render(window, false)
    // The start edge no longer scans back to the horizon: a lower day bound rides the query.
    expect(sql).toContain("day >= ")
    expect(sql).toContain("::date and day <= ")
    // The bound names the first and last UTC day the window can touch.
    expect(params).toContain("2026-09-16")
    expect(params).toContain("2026-10-16")
  })

  test("hourly mode is bounded to the same days", () => {
    const { params } = render(window, true)
    expect(params).toContain("2026-09-16")
    expect(params).toContain("2026-10-16")
  })

  test("a midnight-aligned window ends on the last day it touches, not the exclusive day after", () => {
    // `to` exclusive at midnight: the window touches 09-16..10-15, so `endDay` is 10-15.
    const { params } = render(
      { from: new Date("2026-09-16T00:00:00.000Z"), to: new Date("2026-10-16T00:00:00.000Z") },
      false,
    )
    expect(params).toContain("2026-09-16")
    expect(params).toContain("2026-10-15")
  })
})
