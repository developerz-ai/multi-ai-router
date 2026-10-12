import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import type { TranslationDrop } from "../../../src/services/translate"
import {
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  stripLookaroundPatternsFromTools,
} from "../../../src/services/translate/shared/schema-lookarounds"

/**
 * #187: the Codex backend refuses a tool schema whose `pattern` holds a regex lookaround, so the
 * router strips such patterns from translated tool schemas. Every schema keyword that holds a
 * subschema is walked; data keywords are not; the input is never mutated.
 */

const LOOK = "^(?!-)[a-z]+$"
const PLAIN = "^[a-z]+$"

const SEGMENT = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g

/**
 * Delete the value at a reported drop path. A numeric segment on an object (a `patternProperties`
 * entry) selects that entry by its position, as the report does.
 */
function deleteAt(root: Record<string, unknown>, path: string): void {
  const keys: Array<string | number> = []
  for (const [, name, index, quoted] of path.matchAll(SEGMENT)) {
    if (name !== undefined) keys.push(name)
    else if (index !== undefined) keys.push(Number(index))
    else if (quoted !== undefined) keys.push(JSON.parse(quoted) as string)
  }
  const first = path.match(/^[A-Za-z_$][\w$]*/)?.[0]
  if (first !== undefined) keys.unshift(first)
  let node: unknown = root
  for (const [i, key] of keys.entries()) {
    const holder = node as Record<string, unknown> & unknown[]
    const name =
      typeof key === "number" && !Array.isArray(holder) ? (Object.keys(holder)[key] ?? "") : key
    if (i === keys.length - 1) {
      delete holder[name as string]
      return
    }
    node = holder[name as string]
  }
}

function run(parameters: Record<string, unknown>, name = "auth") {
  const tool = { type: "function", name, description: "kept", strict: false, parameters }
  const body = { model: "gpt-6-luna", tools: [tool] }
  const before = structuredClone(body)
  const drops: TranslationDrop[] = []
  const out = stripLookaroundPatternsFromTools(body, (drop) => drops.push(drop))
  expect(body).toEqual(before)
  // The output is the input with exactly the reported patterns removed: nothing else is lost.
  const expected = structuredClone(before)
  for (const drop of drops) deleteAt(expected, drop.field)
  expect(out).toEqual(expected)
  const tools = out.tools as ReadonlyArray<{ parameters: Record<string, unknown> }>
  return { out, body, params: tools[0]?.parameters, drops, paths: drops.map((d) => d.field).sort() }
}

describe("which patterns are lookarounds", () => {
  test("the issue's fixture is removed and a plain pattern beside it is kept", () => {
    const { params, paths } = run({
      type: "object",
      properties: {
        login: { type: "string", pattern: LOOK },
        name: { type: "string", pattern: PLAIN },
      },
    })
    const props = params?.properties as Record<string, { pattern?: string }>
    expect(props.login?.pattern).toBeUndefined()
    expect(props.name?.pattern).toBe(PLAIN)
    expect(paths).toEqual(["tools[0].parameters.properties.login.pattern"])
  })

  test.each([
    ["positive lookahead", "(?=.*[A-Z]).{6,}"],
    ["negative lookahead", "^(?!-)[a-z]+$"],
    ["positive lookbehind", "(?<=@)[a-z]+"],
    ["negative lookbehind", "(?<!guest).+"],
  ])("%s is removed", (_label, pattern) => {
    const { params, paths } = run({ type: "string", pattern })
    expect(params?.pattern).toBeUndefined()
    expect(paths).toEqual(["tools[0].parameters.pattern"])
  })

  test("a named capture group is not a lookaround and is kept", () => {
    const pattern = "^(?<year>\\d{4})-\\d{2}$"
    const { out, body, params, drops } = run({ type: "string", pattern })
    expect(params?.pattern).toBe(pattern)
    expect(drops).toHaveLength(0)
    expect(out).toBe(body)
  })
})

describe("every subschema keyword is walked", () => {
  const nested = { type: "string", pattern: LOOK }
  test.each<[string, Record<string, unknown>, string]>([
    ["items (object)", { items: nested }, "items.pattern"],
    ["items (array)", { items: [{ type: "string" }, nested] }, "items[1].pattern"],
    ["additionalItems", { additionalItems: nested }, "additionalItems.pattern"],
    ["unevaluatedItems", { unevaluatedItems: nested }, "unevaluatedItems.pattern"],
    ["prefixItems", { prefixItems: [nested] }, "prefixItems[0].pattern"],
    ["additionalProperties", { additionalProperties: nested }, "additionalProperties.pattern"],
    ["unevaluatedProperties", { unevaluatedProperties: nested }, "unevaluatedProperties.pattern"],
    ["propertyNames", { propertyNames: nested }, "propertyNames.pattern"],
    ["contains", { contains: nested }, "contains.pattern"],
    ["contentSchema", { contentSchema: nested }, "contentSchema.pattern"],
    ["not", { not: nested }, "not.pattern"],
    ["if", { if: nested }, "if.pattern"],
    // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword here, never awaited
    ["then", { then: nested }, "then.pattern"],
    ["else", { else: nested }, "else.pattern"],
    ["anyOf", { anyOf: [nested, { type: "null" }] }, "anyOf[0].pattern"],
    ["oneOf", { oneOf: [{ type: "null" }, nested] }, "oneOf[1].pattern"],
    ["allOf", { allOf: [nested] }, "allOf[0].pattern"],
    ["properties", { properties: { login: nested } }, "properties.login.pattern"],
    ["patternProperties", { patternProperties: { "^x-": nested } }, "patternProperties[0].pattern"],
    ["$defs", { $defs: { handle: nested } }, "$defs.handle.pattern"],
    ["definitions", { definitions: { handle: nested } }, "definitions.handle.pattern"],
    ["dependentSchemas", { dependentSchemas: { login: nested } }, "dependentSchemas.login.pattern"],
    [
      "dependencies (schema form)",
      { dependencies: { login: nested, email: ["login"] } },
      "dependencies.login.pattern",
    ],
  ])("%s", (_keyword, schema, path) => {
    const { out, body, paths } = run({ type: "object", ...schema })
    expect(paths).toEqual([`tools[0].parameters.${path}`])
    expect(out).not.toBe(body)
    expect(JSON.stringify(out)).not.toContain(LOOK)
  })

  test("dependencies in property-list form is kept as it was", () => {
    const { out, body, params, drops } = run({
      type: "object",
      dependencies: { email: ["login"] },
      properties: { login: { type: "string", pattern: LOOK } },
    })
    expect(drops).toHaveLength(1)
    expect(out).not.toBe(body)
    expect(params?.dependencies).toEqual({ email: ["login"] })
  })

  test("a deep mix reports every removal, and only those", () => {
    const { out, params, paths } = run({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", pattern: LOOK } },
        handle: { anyOf: [{ $ref: "#/$defs/handle" }, { type: "null" }] },
        keep: { type: "string", pattern: PLAIN },
      },
      $defs: { handle: { type: "string", pattern: "(?<!@)\\w+" } },
    })
    expect(paths).toEqual([
      "tools[0].parameters.$defs.handle.pattern",
      "tools[0].parameters.properties.tags.items.pattern",
    ])
    const text = JSON.stringify(out)
    expect(text).not.toContain(LOOK)
    expect(text).not.toContain("(?<!@)")
    const props = params?.properties as Record<string, { pattern?: string }>
    expect(props.keep?.pattern).toBe(PLAIN)
  })
})

describe("what is never touched", () => {
  test("a `pattern` key inside default, enum, examples or const data is kept", () => {
    const data = { pattern: LOOK }
    const schema = {
      type: "object",
      default: data,
      enum: [data],
      examples: [data],
      const: data,
    }
    const { out, body, drops } = run(schema)
    expect(drops).toHaveLength(0)
    expect(out).toBe(body)
  })

  test("a property named __proto__ survives when a sibling is stripped", () => {
    const parameters = JSON.parse(
      `{"type":"object","properties":{"__proto__":{"type":"string","description":"kept"},"login":{"type":"string","pattern":"${LOOK.replace(/\\/g, "\\\\")}"}}}`,
    ) as Record<string, unknown>
    const { params, paths } = run(parameters)
    const props = params?.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(["__proto__", "login"])
    expect(Object.getOwnPropertyDescriptor(props, "__proto__")?.value).toEqual({
      type: "string",
      description: "kept",
    })
    expect(paths).toEqual(["tools[0].parameters.properties.login.pattern"])
  })

  test("a body with no lookaround comes back as the same reference", () => {
    const { out, body } = run({
      type: "object",
      properties: { name: { type: "string", pattern: PLAIN } },
    })
    expect(out).toBe(body)
  })
})

describe("what a drop report carries", () => {
  test("the tool name and a structural path, never the pattern value or a patternProperties key", () => {
    const key = "^(?=secret)x-"
    const { drops } = run(
      { type: "object", patternProperties: { [key]: { type: "string", pattern: LOOK } } },
      "auth",
    )
    expect(drops).toEqual([
      {
        field: "tools[0].parameters.patternProperties[0].pattern",
        reason:
          "the target account's Responses surface cannot compile regex lookarounds in tool schemas (tool `auth`)",
      },
    ])
    const text = JSON.stringify(drops)
    expect(text).not.toContain(LOOK)
    expect(text).not.toContain("secret")
  })
})

describe("depth and size bounds", () => {
  function nest(levels: number): Record<string, unknown> {
    let schema: Record<string, unknown> = { type: "string", pattern: LOOK }
    for (let i = 0; i < levels; i += 1) schema = { type: "array", items: schema }
    return schema
  }

  test(`a schema ${MAX_SCHEMA_DEPTH} levels deep is walked`, () => {
    const { paths } = run(nest(MAX_SCHEMA_DEPTH))
    expect(paths).toHaveLength(1)
  })

  test("a schema deeper than the bound with no lookaround anywhere is not walked, so not refused", () => {
    let parameters: Record<string, unknown> = { type: "string", pattern: PLAIN }
    for (let i = 0; i <= MAX_SCHEMA_DEPTH; i += 1) parameters = { type: "array", items: parameters }
    const { out, body, drops } = run(parameters)
    expect(drops).toHaveLength(0)
    expect(out).toBe(body)
  })

  test(`more than ${MAX_SCHEMA_NODES} subschemas in a walked schema is refused, not walked to the end`, () => {
    const parameters = {
      description: "(?=x)",
      anyOf: Array.from({ length: MAX_SCHEMA_NODES }, () => ({})),
    }
    const body = { tools: [{ type: "function", name: "wide", parameters }] }
    expect(() => stripLookaroundPatternsFromTools(body, () => undefined)).toThrow(TranslationError)
  })

  test(`exactly ${MAX_SCHEMA_NODES} subschemas, the root included, is walked`, () => {
    const anyOf: Array<Record<string, unknown>> = Array.from(
      { length: MAX_SCHEMA_NODES - 2 },
      () => ({}),
    )
    anyOf.push({ type: "string", pattern: LOOK })
    const { paths } = run({ anyOf })
    expect(paths).toEqual([`tools[0].parameters.anyOf[${MAX_SCHEMA_NODES - 2}].pattern`])
  })

  test("one level deeper is refused with a TranslationError (a 400), not a stack overflow", () => {
    const body = {
      tools: [{ type: "function", name: "deep", parameters: nest(MAX_SCHEMA_DEPTH + 1) }],
    }
    expect(() => stripLookaroundPatternsFromTools(body, () => undefined)).toThrow(TranslationError)
  })
})
