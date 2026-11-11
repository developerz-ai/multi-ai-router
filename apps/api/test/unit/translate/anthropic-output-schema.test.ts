/**
 * A client schema reduced to Anthropic's native structured-output subset (10.4).
 *
 * Prod, 2026-11-09…10 on 2.55.0: 13 × `output_config.format.schema: For 'array' type, property
 * 'maxItems' is not supported` relayed to the client, because the schema travelled verbatim.
 */

import { describe, expect, test } from "bun:test"
import type { TranslationDrop } from "../../../src/services/translate"
import { anthropicOutputSchema } from "../../../src/services/translate/shared/anthropic-output-schema"

function sanitize(schema: Record<string, unknown>) {
  const drops: TranslationDrop[] = []
  const out = anthropicOutputSchema(schema, (drop) => drops.push(drop))
  if (out === null) throw new Error("expected a sanitized schema")
  return { out, drops }
}

function props(out: { schema: Record<string, unknown> }) {
  return out.schema.properties as Record<string, Record<string, unknown>>
}

const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

describe("anthropicOutputSchema", () => {
  test("prod fingerprint: `maxItems` is removed, restated, and reported by path", () => {
    const schema = closed({ tags: { type: "array", items: { type: "string" }, maxItems: 5 } })
    const { out, drops } = sanitize(schema)
    const tags = props(out).tags
    expect(tags?.maxItems).toBeUndefined()
    expect(tags?.items).toEqual({ type: "string" })
    expect(tags?.description).toBe("{maxItems: 5}")
    expect(drops).toEqual([
      {
        field: "response_format.json_schema.schema.properties.tags.maxItems",
        reason: expect.stringContaining("subset"),
      },
    ])
    // The caller's own object is never touched.
    expect((schema.properties.tags as Record<string, unknown>).maxItems).toBe(5)
  })

  test("numeric and string constraints are restated after an existing description", () => {
    const { out, drops } = sanitize(
      closed({
        n: { type: "integer", minimum: 1, maximum: 9 },
        s: { type: "string", description: "a name", minLength: 2, pattern: "^a" },
      }),
    )
    const fields = props(out)
    expect(fields.n).toEqual({ type: "integer", description: "{minimum: 1, maximum: 9}" })
    expect(fields.s?.description).toBe('a name\n\n{minLength: 2, pattern: "^a"}')
    expect(drops.map((drop) => drop.field.split(".").at(-1))).toEqual([
      "minimum",
      "maximum",
      "minLength",
      "pattern",
    ])
  })

  test("supported keywords survive and an already-supported schema is the same reference", () => {
    const schema = closed({
      when: { type: "string", format: "date-time" },
      kind: { enum: ["a", "b"] },
      list: { type: "array", items: { $ref: "#/$defs/x" }, minItems: 1 },
      either: { anyOf: [{ type: "string" }, { type: "null" }] },
    })
    const withDefs = { ...schema, $defs: { x: closed({ y: { const: 1 } }) } }
    const { out, drops } = sanitize(withDefs)
    expect(out.schema).toBe(withDefs)
    expect(drops).toEqual([])
  })

  test("an unsupported format and minItems above 1 are restated", () => {
    const { out } = sanitize(
      closed({
        url: { type: "string", format: "iri" },
        list: { type: "array", items: { type: "string" }, minItems: 2 },
      }),
    )
    const fields = props(out)
    expect(fields.url).toEqual({ type: "string", description: '{format: "iri"}' })
    expect(fields.list?.minItems).toBeUndefined()
  })

  test("annotations go silently; oneOf becomes anyOf and is reported", () => {
    const { out, drops } = sanitize({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...closed({ v: { oneOf: [{ type: "string" }, { type: "number" }], default: "x" } }),
    })
    expect(out.schema.$schema).toBeUndefined()
    const v = props(out).v
    expect(v).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] })
    expect(drops.map((drop) => drop.field)).toEqual([
      "response_format.json_schema.schema.properties.v.oneOf",
    ])
  })

  test("an open object is left open for the caller's native check to refuse", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } }
    expect(sanitize(schema).out.schema).toBe(schema)
  })

  test("complexity counts: optional properties and unions", () => {
    const { out } = sanitize(
      closed(
        {
          a: { type: ["string", "null"] },
          b: { anyOf: [{ type: "string" }, { type: "integer" }] },
          c: { type: "string" },
        },
        ["a"],
      ),
    )
    expect(out.optionalProperties).toBe(2)
    expect(out.unions).toBe(2)
    expect(out.nodes).toBe(6)
  })

  test("a schema nested past the depth bound is not handed to a compiler", () => {
    let deep: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < 70; i += 1) deep = { type: "array", items: deep }
    expect(anthropicOutputSchema(deep, () => undefined)).toBeNull()
  })

  test("a `__proto__` property name stays an own key", () => {
    const properties = JSON.parse('{"__proto__": {"type": "string", "maxLength": 3}}')
    const { out } = sanitize({ type: "object", properties, additionalProperties: false })
    expect(Object.hasOwn(props(out), "__proto__")).toBe(true)
  })
})
