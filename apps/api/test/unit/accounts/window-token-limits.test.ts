import { describe, expect, test } from "bun:test"
import { createAccountBody, updateAccountBody } from "../../../src/services/accounts"

/**
 * The operator's per-window token ceilings — the figure the console's measured bar is a fraction of.
 *
 * The bug these exist for is subtle and shipped once: Zod treats a record keyed by an **enum** as
 * exhaustive, so `z.record(QuotaWindowKind, …)` silently demands a ceiling for all five window
 * kinds and rejects `{ five_hour: 2_000_000 }` with "seven_day_opus: expected number, received
 * undefined". A real Max plan has one or two windows an operator cares about, so a partial map is
 * the normal case, not the edge one.
 */
describe("windowTokenLimits", () => {
  const base = { label: "claude-a", provider: "anthropic-oauth" as const }

  test("accepts a ceiling for only the windows the operator cares about", () => {
    const parsed = createAccountBody.safeParse({
      ...base,
      windowTokenLimits: { five_hour: 2_000_000 },
    })

    expect(parsed.success).toBe(true)
    expect(parsed.data?.windowTokenLimits).toEqual({ five_hour: 2_000_000 })
  })

  test("accepts several windows at once", () => {
    const parsed = createAccountBody.safeParse({
      ...base,
      windowTokenLimits: { five_hour: 2_000_000, seven_day: 20_000_000 },
    })

    expect(parsed.success).toBe(true)
  })

  test("is optional — an account with no ceilings is the default", () => {
    expect(createAccountBody.safeParse(base).success).toBe(true)
  })

  test("rejects a window kind this build does not know", () => {
    const parsed = createAccountBody.safeParse({
      ...base,
      windowTokenLimits: { monthly: 1_000 },
    })

    expect(parsed.success).toBe(false)
  })

  /** Zero would render as permanently 100% spent; a negative ceiling has no meaning at all. */
  test("rejects a ceiling that is zero, negative, or fractional", () => {
    for (const value of [0, -1, 1.5]) {
      const parsed = createAccountBody.safeParse({
        ...base,
        windowTokenLimits: { five_hour: value },
      })
      expect(parsed.success).toBe(false)
    }
  })

  test("null on an update clears every ceiling rather than zeroing them", () => {
    const parsed = updateAccountBody.safeParse({ windowTokenLimits: null })

    expect(parsed.success).toBe(true)
    expect(parsed.data?.windowTokenLimits).toBeNull()
  })
})
