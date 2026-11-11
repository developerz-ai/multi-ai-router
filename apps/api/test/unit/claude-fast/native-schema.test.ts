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

  test("an anyOf or allOf branch missing the flag is not native", () => {
    for (const key of ["anyOf", "allOf"]) {
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

  // 101 finding 10.4 — the prod rejections, each answered natively by a 400 (13 × in 0.13–0.2 s)
  // or after a ~180 s grammar compile (48 ×). Each now rides the adapted tool before any send.
  test("a keyword Anthropic's structured outputs refuse is not native (prod: maxItems)", () => {
    const refused: Record<string, unknown>[] = [
      { type: "array", items: { type: "string" }, maxItems: 5 },
      { type: "array", items: { type: "string" }, minItems: 2 },
      { type: "array", items: { type: "string" }, uniqueItems: true },
      { type: "integer", minimum: 0 },
      { type: "number", maximum: 1 },
      { type: "number", multipleOf: 2 },
      { type: "string", minLength: 1 },
      { type: "string", maxLength: 9 },
      { oneOf: [{ type: "string" }, { type: "integer" }] },
      { not: { type: "string" } },
      { type: "array", prefixItems: [{ type: "string" }] },
      { type: "array", items: [{ type: "string" }] },
    ]
    for (const node of refused) expect(nativeStructuredSchema(closed({ x: node }))).toBe(false)
  })

  test("the supported array bounds stay native: minItems 0 or 1", () => {
    for (const minItems of [0, 1])
      expect(
        nativeStructuredSchema(
          closed({ x: { type: "array", items: { type: "string" }, minItems } }),
        ),
      ).toBe(true)
  })

  test("a recursive or unresolvable $ref is not native", () => {
    expect(nativeStructuredSchema(closed({ self: { $ref: "#" } }))).toBe(false)
    expect(nativeStructuredSchema(closed({ ref: { $ref: "#/$defs/missing" } }))).toBe(false)
    expect(
      nativeStructuredSchema({
        ...closed({ tree: { $ref: "#/$defs/node" } }),
        $defs: {
          node: closed({ children: { type: "array", items: { $ref: "#/$defs/node" } } }),
        },
      }),
    ).toBe(false)
    expect(
      nativeStructuredSchema({
        ...closed({ a: { $ref: "#/definitions/a" } }),
        definitions: {
          a: closed({ b: { $ref: "#/definitions/b" } }),
          b: closed({ a: { $ref: "#/definitions/a" } }),
        },
      }),
    ).toBe(false)
  })

  test("a schema past the complexity budget is not native (prod: 'Schema is too complex.')", () => {
    const many = (count: number, node: Record<string, unknown>) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, node]))
    // 24 optional properties is Anthropic's published ceiling; 25 is over it.
    expect(nativeStructuredSchema(closed(many(24, { type: "string" })))).toBe(true)
    expect(nativeStructuredSchema(closed(many(25, { type: "string" })))).toBe(false)
    // Required properties do not count towards the optional ceiling.
    const required = {
      ...closed(many(30, { type: "string" })),
      required: Object.keys(many(30, {})),
    }
    expect(nativeStructuredSchema(required)).toBe(true)
    // 16 union-typed properties is the other published ceiling.
    const unions = (count: number) => ({
      ...closed(many(count, { type: ["string", "null"] })),
      required: Object.keys(many(count, {})),
    })
    expect(nativeStructuredSchema(unions(16))).toBe(true)
    expect(nativeStructuredSchema(unions(17))).toBe(false)
    // And a total node ceiling for a large generated schema.
    const wide = { ...closed(many(250, { type: "string" })), required: Object.keys(many(250, {})) }
    expect(nativeStructuredSchema(wide)).toBe(false)
  })
})
