import { describe, expect, test } from "bun:test"
import type { UsageWindow } from "@multi-ai-router/db"
import { resolveReadWindow } from "../../../src/services/usage-read/read-window"

/**
 * Resolving the window needs the db clock and — for "lifetime" — the earliest retained instant, and
 * nothing else. Issue #250: it used to call `coverage()` with no window, whose `pending`/`legacy`
 * anti-joins scan every retained row, ~half the cost of a large summary, for two fields. The window
 * step must take the lightweight `clock()` read and never reach for the full coverage scan.
 */

const DB_NOW = new Date("2026-10-16T18:00:00.000Z")

function stub(earliestAt: Date | null) {
  let clockCalls = 0
  let coverageCalls = 0
  const history = {
    clock: async () => {
      clockCalls += 1
      return { dbNow: DB_NOW, earliestAt }
    },
    // The prod regression: the window step ran the full coverage scan. It must not be called here.
    coverage: async (_window?: UsageWindow) => {
      coverageCalls += 1
      throw new Error("resolveReadWindow must not run the full coverage scan")
    },
  }
  return { history, counts: () => ({ clockCalls, coverageCalls }) }
}

describe("resolveReadWindow", () => {
  test("takes the clock, never the full coverage scan", async () => {
    const { history, counts } = stub(new Date("2026-01-02T03:04:05.000Z"))
    await resolveReadWindow(history, { window: "30d" })
    expect(counts()).toEqual({ clockCalls: 1, coverageCalls: 0 })
  })

  test("lifetime starts at the earliest retained instant from the clock read", async () => {
    const earliest = new Date("2026-01-02T03:04:05.000Z")
    const { history } = stub(earliest)
    const window = await resolveReadWindow(history, { window: "lifetime" })
    expect(window.from).toBe(earliest)
    expect(window.to).toBe(DB_NOW)
    expect(window.label).toBe("lifetime")
  })

  test("lifetime with no retained history collapses to the clock instant", async () => {
    const { history } = stub(null)
    const window = await resolveReadWindow(history, { window: "lifetime" })
    expect(window.from).toEqual(DB_NOW)
    expect(window.to).toEqual(DB_NOW)
  })

  test("a named window is resolved against the db clock, not the wall clock", async () => {
    const { history } = stub(null)
    const window = await resolveReadWindow(history, { window: "30d" })
    expect(window.to).toBe(DB_NOW)
    expect(window.from).toEqual(new Date(DB_NOW.getTime() - 30 * 24 * 60 * 60 * 1000))
  })
})
