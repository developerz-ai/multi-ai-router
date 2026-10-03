import { describe, expect, test } from "bun:test"
import { ownEntry } from "../../src"

describe("ownEntry", () => {
  test("accepts missing dictionaries", () => {
    expect(ownEntry(undefined, "model")).toBeUndefined()
    expect(ownEntry(null, "model")).toBeUndefined()
  })

  test("ignores inherited values without invoking inherited getters", () => {
    const values = { own: "declared" }
    Object.setPrototypeOf(
      values,
      Object.defineProperty({}, "inherited", {
        get() {
          throw new Error("an inherited getter must not run")
        },
      }),
    )
    expect(ownEntry(values, "own")).toBe("declared")
    expect(ownEntry(values, "inherited")).toBeUndefined()
    expect(ownEntry(values, "constructor")).toBeUndefined()
  })

  test("preserves explicit entries even when they shadow object methods", () => {
    const values = Object.fromEntries([
      ["constructor", "constructor-model"],
      ["__proto__", "prototype-model"],
      ["hasOwnProperty", "property-model"],
    ])
    expect(ownEntry(values, "constructor")).toBe("constructor-model")
    expect(ownEntry(values, "__proto__")).toBe("prototype-model")
    expect(ownEntry(values, "hasOwnProperty")).toBe("property-model")
  })

  test("supports dictionaries with no prototype and preserves falsy values", () => {
    const values = { zero: 0, no: false, empty: "", null: null }
    Object.setPrototypeOf(values, null)
    expect(ownEntry(values, "zero")).toBe(0)
    expect(ownEntry(values, "no")).toBe(false)
    expect(ownEntry(values, "empty")).toBe("")
    expect(ownEntry(values, "null")).toBeNull()
    expect(ownEntry(values, "toString")).toBeUndefined()
  })
})
