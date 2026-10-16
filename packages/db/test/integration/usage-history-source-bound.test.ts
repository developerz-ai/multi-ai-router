import { describe, expect, test } from "bun:test"
import { usageRecords } from "../../src/schema/usage-records"
import { historyAttempt, historyUrl, usageHistoryFixture } from "./usage-history-fixture"

/**
 * The contributions day bound added for issue #250 must change the summary numbers for no window.
 * It drops only days the window's event-time filter already excluded, so a seeded set with rows on
 * both sides of the bound — a partial start day, a full in-window day, and days wholly before the
 * window — reads exactly the in-window attempts, across several windows including lifetime.
 *
 * This is the "output unchanged" gate: the expected numbers are what the unbounded query produced
 * too, because `day` is the UTC day of `eventAt`, so no row with `eventAt` in `[from, to)` can have
 * a `day` outside `[startDay, endDay]`.
 */
const fixture = usageHistoryFixture()

describe.skipIf(!historyUrl)("historySource contributions day bound (output unchanged)", () => {
  test("reads exactly the in-window attempts across windows with rows straddling the bound", async () => {
    const attempt = (iso: string) => historyAttempt({ createdAt: new Date(iso) })
    const rows = [
      // Wholly before the 30-day-style window: excluded, on the far side of the lower day bound.
      attempt("1983-12-01T12:00:00Z"),
      // Partial start day (window opens mid-day): one instant before `from`, one after.
      attempt("1984-01-10T06:00:00Z"), // before `from` → excluded by the event-time filter
      attempt("1984-01-10T18:00:00Z"), // after `from`  → counted (read via the partial start edge)
      attempt("1984-01-10T20:00:00Z"), // counted
      // A full in-window day, read from the daily aggregates, not the partial edge.
      attempt("1984-01-15T12:00:00Z"),
      attempt("1984-01-15T13:00:00Z"),
      attempt("1984-01-15T14:00:00Z"),
      // Wholly after the window: excluded, on the far side of the upper day bound.
      attempt("1984-03-01T12:00:00Z"),
    ]
    await fixture.db().insert(usageRecords).values(rows)
    // Bank every raw row into durable contributions so the facts source reads them.
    for (let guard = 0; guard < rows.length + 2; guard += 1) {
      const { remaining } = await fixture.history().backfill({ limit: 3 })
      if (!remaining) break
    }

    const windowed = {
      from: new Date("1984-01-10T12:00:00Z"),
      to: new Date("1984-02-01T00:00:00Z"),
    }
    // Partial start day (2) + the full in-window day (3); the 06:00 row and both out-of-window
    // days are excluded. tokensIn is 3 per attempt.
    expect(await fixture.history().totals(windowed)).toMatchObject({ attempts: 5, tokensIn: 15 })

    // A window whose edges are both partial days, so both edges ride the contributions path.
    const bothEdges = {
      from: new Date("1984-01-10T12:00:00Z"),
      to: new Date("1984-01-15T13:30:00Z"),
    }
    // 2 on the partial start day + 2 of the three on 01-15 (12:00, 13:00 before 13:30; 14:00 after).
    expect(await fixture.history().totals(bothEdges)).toMatchObject({ attempts: 4, tokensIn: 12 })

    // Lifetime: every banked attempt, both sides included.
    const lifetime = { from: new Date(0), to: new Date("2026-01-01T00:00:00Z") }
    expect(await fixture.history().totals(lifetime)).toMatchObject({ attempts: 8, tokensIn: 24 })

    // The per-key breakdown adds up to the same windowed total: the bound did not drop a group.
    const byKey = await fixture.history().breakdown(windowed, "apiKeyId", 100, {})
    expect(byKey.reduce((sum, row) => sum + row.attempts, 0)).toBe(5)
  })
})
