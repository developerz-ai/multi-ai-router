import { describe, expect, test } from "bun:test"
import { nativeStructuredSchema } from "../../../src/providers/claude-fast/native-schema"

const closed = (properties: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  additionalProperties: false,
})

describe("native structured-output schema compatibility (pure)", () => {
  test("a schema whose every object node states additionalProperties false is native", () => {
    expect(
      nativeStructuredSchema(
        closed({
          ok: { type: "boolean" },
          nested: closed({ name: { type: "string" } }),
          list: { type: "array", items: closed({ id: { type: "integer" } }) },
          either: { anyOf: [closed(), { type: "string" }] },
          ref: { $ref: "#/$defs/thing" },
        }),
      ),
    ).toBe(true)
    expect(
      nativeStructuredSchema({
        ...closed({ ref: { $ref: "#/$defs/thing" } }),
        $defs: { thing: closed() },
      }),
    ).toBe(true)
  })

  test("json_object's bare root object is not native", () => {
    expect(nativeStructuredSchema({ type: "object" })).toBe(false)
  })

  test("a root that leaves additionalProperties open or true is not native", () => {
    expect(
      nativeStructuredSchema({ type: "object", properties: { ok: { type: "boolean" } } }),
    ).toBe(false)
    expect(nativeStructuredSchema({ ...closed(), additionalProperties: true })).toBe(false)
  })

  test("a nested property object missing the flag is not native", () => {
    expect(nativeStructuredSchema(closed({ inner: { type: "object", properties: {} } }))).toBe(
      false,
    )
  })

  test("an array's item object missing the flag is not native", () => {
    expect(
      nativeStructuredSchema(closed({ list: { type: "array", items: { type: "object" } } })),
    ).toBe(false)
    expect(
      nativeStructuredSchema(
        closed({ tuple: { type: "array", prefixItems: [{ type: "object" }] } }),
      ),
    ).toBe(false)
  })

  test("an anyOf, oneOf or allOf branch missing the flag is not native", () => {
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      expect(nativeStructuredSchema(closed({ x: { [key]: [closed(), { type: "object" }] } }))).toBe(
        false,
      )
    }
  })

  test("a $defs or definitions entry missing the flag is not native", () => {
    for (const key of ["$defs", "definitions"]) {
      expect(nativeStructuredSchema({ ...closed(), [key]: { thing: { type: "object" } } })).toBe(
        false,
      )
    }
  })

  test("an object node without a stated type, or a type list naming object, is still checked", () => {
    expect(nativeStructuredSchema(closed({ x: { properties: { a: { type: "string" } } } }))).toBe(
      false,
    )
    expect(nativeStructuredSchema(closed({ x: { type: ["object", "null"] } }))).toBe(false)
  })

  test("a schema that is not an object at all is not native", () => {
    expect(nativeStructuredSchema(undefined)).toBe(false)
    expect(nativeStructuredSchema([])).toBe(false)
  })
})
