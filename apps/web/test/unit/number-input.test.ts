import { describe, expect, test } from "bun:test"
import { readNumberInput } from "../../src/lib/number-input"
import { numeric } from "../../src/routes/accounts/RoutingNumberFields"

// A number box accepts `1e3`; `Number.parseInt` read it as 1. Every numeric form field goes
// through `readNumberInput`, so this is the one place the reading rule is pinned.

describe("readNumberInput", () => {
  test("reads the exponent form as the number the browser accepted", () => {
    expect(readNumberInput("1e3")).toBe(1000)
    expect(readNumberInput(" 42 ")).toBe(42)
    expect(readNumberInput("0.5")).toBe(0.5)
  })

  test("empty or unreadable is null, never NaN or zero", () => {
    expect(readNumberInput("")).toBeNull()
    expect(readNumberInput("   ")).toBeNull()
    expect(readNumberInput("abc")).toBeNull()
    expect(readNumberInput("Infinity")).toBeNull()
  })
})

describe("numeric (account weight / priority)", () => {
  test("1e3 is a weight of a thousand", () => {
    expect(numeric("weight", "1e3")).toEqual({ weight: 1000 })
  })

  test("an unreadable box leaves the field out instead of sending NaN", () => {
    expect(numeric("priority", "")).toEqual({})
  })
})
