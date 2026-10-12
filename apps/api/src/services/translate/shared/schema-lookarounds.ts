import type { DropSink } from "./drops"
import { rejectField } from "./reject"

/**
 * Removes JSON-Schema `pattern`s that contain a regex lookaround from translated tool schemas, for
 * a Responses surface that cannot compile them (`ResponsesEgressRules.stripLookaroundPatterns`).
 *
 * Only true lookarounds match — `(?=`, `(?!`, `(?<=`, `(?<!`. A named capture group `(?<name>…)`
 * is not one and is kept. The test is a substring match, so an escaped `\(?=` or a bracketed
 * `[(?=]` over-matches; the cost is one dropped validation hint, reported by path.
 *
 * The walk follows the schema keywords that hold subschemas, from a table, and nothing else: data
 * keywords (`default`, `enum`, `examples`, `const`) are never entered, so a `pattern` key inside
 * data survives. `patternProperties` regex *keys* are out of scope; their subschema values are
 * walked. Nothing is mutated — the parsed source is reused across failover candidates
 * (`dataplane/translate-body.ts`) — and an unchanged schema comes back as the same reference.
 */

const LOOKAROUND = /\(\?(?:[=!]|<[=!])/

/**
 * Nesting past this depth is refused with a `400` rather than walked. A structural guard, not a
 * tuning knob: real tool schemas stay within a handful of levels, and recursing without a bound
 * would let a hostile body turn a translation into a stack overflow and a generic `500`.
 */
export const MAX_SCHEMA_DEPTH = 64

/** Keywords whose value is one subschema. `items` is listed here and in ARRAY: its two forms. */
const SINGLE = [
  "items",
  "not",
  "additionalProperties",
  "propertyNames",
  "contains",
  "if",
  "then",
  "else",
]
/** Keywords whose value is an array of subschemas. */
const ARRAY = ["items", "prefixItems", "anyOf", "oneOf", "allOf"]
/** Keywords whose value maps names to subschemas. */
const MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** An own-property copy that keeps every key, `__proto__` included (CreateDataProperty, not [[Set]]). */
function copyOf(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record))
}

function defineOn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** A path segment for a map entry. `patternProperties` keys are client regexes: index only. */
function mapSegment(keyword: string, key: string, index: number): string {
  if (keyword === "patternProperties") return `${keyword}[${index}]`
  return IDENTIFIER.test(key) ? `${keyword}.${key}` : `${keyword}[${JSON.stringify(key)}]`
}

interface WalkContext {
  readonly reason: string
  readonly onDrop: DropSink
}

function walk(
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  ctx: WalkContext,
): Record<string, unknown> {
  if (depth > MAX_SCHEMA_DEPTH) {
    rejectField(path, `nests deeper than ${MAX_SCHEMA_DEPTH} schema levels`)
  }
  let next: Record<string, unknown> | undefined
  const replace = (key: string, value: unknown) => {
    next ??= copyOf(schema)
    defineOn(next, key, value)
  }

  if (typeof schema.pattern === "string" && LOOKAROUND.test(schema.pattern)) {
    next = copyOf(schema)
    delete next.pattern
    ctx.onDrop({ field: `${path}.pattern`, reason: ctx.reason })
  }

  for (const keyword of SINGLE) {
    const sub = schema[keyword]
    if (!isPlainObject(sub)) continue
    const walked = walk(sub, `${path}.${keyword}`, depth + 1, ctx)
    if (walked !== sub) replace(keyword, walked)
  }

  for (const keyword of ARRAY) {
    const list = schema[keyword]
    if (!Array.isArray(list)) continue
    let changed: unknown[] | undefined
    for (const [index, sub] of list.entries()) {
      if (!isPlainObject(sub)) continue
      const walked = walk(sub, `${path}.${keyword}[${index}]`, depth + 1, ctx)
      if (walked === sub) continue
      changed ??= list.slice()
      changed[index] = walked
    }
    if (changed !== undefined) replace(keyword, changed)
  }

  for (const keyword of MAP) {
    const map = schema[keyword]
    if (!isPlainObject(map)) continue
    let changed = false
    const entries = Object.entries(map).map(([key, sub], index): [string, unknown] => {
      if (!isPlainObject(sub)) return [key, sub]
      const walked = walk(sub, `${path}.${mapSegment(keyword, key, index)}`, depth + 1, ctx)
      if (walked !== sub) changed = true
      return [key, walked]
    })
    if (changed) replace(keyword, Object.fromEntries(entries))
  }

  return next ?? schema
}

/**
 * Strip lookaround `pattern`s from every `tools[i].parameters` schema of a Responses body. The body
 * and a tool are rebuilt only when something under them changed; otherwise the input is returned.
 *
 * @throws TranslationError when a schema nests deeper than {@link MAX_SCHEMA_DEPTH}.
 */
export function stripLookaroundPatternsFromTools(
  body: Record<string, unknown>,
  onDrop: DropSink,
): Record<string, unknown> {
  const tools = body.tools
  if (!Array.isArray(tools)) return body
  let nextTools: unknown[] | undefined
  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool) || !isPlainObject(tool.parameters)) continue
    const name = typeof tool.name === "string" ? tool.name : `tools[${index}]`
    const reason = `the target account's Responses surface cannot compile regex lookarounds in tool schemas (tool \`${name}\`)`
    const parameters = tool.parameters
    const walked = walk(parameters, `tools[${index}].parameters`, 0, { reason, onDrop })
    if (walked === parameters) continue
    nextTools ??= tools.slice()
    const nextTool = copyOf(tool)
    defineOn(nextTool, "parameters", walked)
    nextTools[index] = nextTool
  }
  if (nextTools === undefined) return body
  const out = copyOf(body)
  defineOn(out, "tools", nextTools)
  return out
}
