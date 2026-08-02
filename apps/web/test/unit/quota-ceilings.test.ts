import { describe, expect, test } from "bun:test"
import {
  CEILING_WINDOWS,
  parseCeilings,
  seedCeilings,
} from "../../src/routes/accounts/QuotaCeilingFields"

// The pure half of the ceiling boxes: stored limits → box strings → the PATCH field. The failure
// this pins first: before these boxes existed the API accepted `windowTokenLimits` and nothing in
// the console could write it, so the entire measured-bar path was dead code.

describe("parseCeilings", () => {
  test("all boxes empty is null — the clear-everything spelling, never an empty object", () => {
    // `{}` and `null` are different PATCH bodies: `{}` would store an empty map, `null` clears
    // the column. Only the second removes the bars.
    expect(parseCeilings({})).toBeNull()
    expect(parseCeilings({ five_hour: "", seven_day: "   " })).toBeNull()
  })

  test("a garbage or non-positive box contributes nothing rather than a NaN or a zero", () => {
    // The inputs' min/step refuse these in the browser first; this is the belt behind them —
    // a zero ceiling would render a permanently-full bar, a NaN one a broken gauge.
    expect(parseCeilings({ five_hour: "abc" })).toBeNull()
    expect(parseCeilings({ five_hour: "0" })).toBeNull()
    expect(parseCeilings({ five_hour: "-5" })).toBeNull()
  })

  test("typed ceilings become integers keyed by window", () => {
    expect(parseCeilings({ five_hour: "3000000", seven_day: " 5000000 " })).toEqual({
      five_hour: 3_000_000,
      seven_day: 5_000_000,
    })
  })
})

describe("seedCeilings", () => {
  test("no stored limits opens every box empty, not zeroed", () => {
    expect(seedCeilings(null)).toEqual({})
    expect(seedCeilings(undefined)).toEqual({})
  })

  test("stored limits round-trip through the boxes unchanged", () => {
    const seeded = seedCeilings({ five_hour: 3_000_000, seven_day_opus: 800_000 })
    expect(seeded).toEqual({ five_hour: "3000000", seven_day_opus: "800000" })
    expect(parseCeilings(seeded)).toEqual({ five_hour: 3_000_000, seven_day_opus: 800_000 })
  })

  test("an overage limit is never seeded into a box — there is no box for it", () => {
    expect(CEILING_WINDOWS).not.toContain("overage")
    expect(seedCeilings({ overage: 1_000 })).toEqual({})
  })
})
