import { describe, expect, test } from "bun:test"
import type { UsageTotals } from "@multi-ai-router/db"
import { EMPTY_TOTALS, sumTotals } from "../../../src/services/usage-read"

/**
 * Adding unpriced attempts across the slices of one window. Null means "not measured", so it
 * survives only while every slice is unmeasured; one measured slice makes the sum a number.
 */

const part = (attempts: number | null): UsageTotals => ({
  ...EMPTY_TOTALS,
  unpriced: { attempts, since: "2026-10-15" },
})

describe("unpriced attempts across window slices", () => {
  test("an empty set of parts stays not measured, never zero", () => {
    expect(EMPTY_TOTALS.unpriced).toEqual({ attempts: null, since: "infinity" })
    expect(sumTotals([]).unpriced).toEqual({ attempts: null, since: "infinity" })
  })

  test("two unmeasured slices stay null; one measured slice makes a number", () => {
    expect(sumTotals([part(null), part(null)]).unpriced.attempts).toBeNull()
    expect(sumTotals([part(null), part(5)]).unpriced.attempts).toBe(5)
    expect(sumTotals([part(5), part(null)]).unpriced.attempts).toBe(5)
    expect(sumTotals([part(2), part(3)]).unpriced).toEqual({ attempts: 5, since: "2026-10-15" })
  })
})
