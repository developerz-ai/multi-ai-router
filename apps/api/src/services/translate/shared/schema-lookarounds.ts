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
 * Structural guards, not tuning knobs: real tool schemas stay within a handful of levels and a few
 * hundred nodes. They bound this walk's own recursion and CPU — the depth per schema, the node count
 * across every walked tool in the request — so a hostile body becomes a `400` rather than a stack
 * overflow or a long walk. The lookaround precheck's one serialization per tool is bounded by the
 * request size cap, not by these; a body nested deeper than the request scanner's
 * `MAX_REQUEST_JSON_DEPTH` is refused before translation ever runs.
 */
export const MAX_SCHEMA_DEPTH = 64
export const MAX_SCHEMA_NODES = 10_000

type Shape = "single" | "array" | "map"

/**
 * The keywords that hold subschemas, by the shape of their value. `items` takes both the object and
 * the array form. Draft-7 `dependencies` mixes subschema values with property-name arrays; only the
 * object values are walked.
 */
const SUBSCHEMA_KEYWORDS: ReadonlyMap<string, readonly Shape[]> = new Map([
  ["items", ["single", "array"]],
  ["additionalItems", ["single"]],
  ["unevaluatedItems", ["single"]],
  ["not", ["single"]],
  ["additionalProperties", ["single"]],
  ["unevaluatedProperties", ["single"]],
  ["propertyNames", ["single"]],
  ["contains", ["single"]],
  ["contentSchema", ["single"]],
  ["if", ["single"]],
  ["then", ["single"]],
  ["else", ["single"]],
  ["prefixItems", ["array"]],
  ["anyOf", ["array"]],
  ["oneOf", ["array"]],
  ["allOf", ["array"]],
  ["properties", ["map"]],
  ["patternProperties", ["map"]],
  ["$defs", ["map"]],
  ["definitions", ["map"]],
  ["dependentSchemas", ["map"]],
  ["dependencies", ["map"]],
])

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
  /** Shared by every tool in the body: the bound is per request, so splitting a schema gains nothing. */
  readonly budget: { nodes: number }
}

/** The walked value for one keyword, or the same reference when nothing under it changed. */
function walkKeyword(
  keyword: string,
  value: unknown,
  path: string,
  depth: number,
  ctx: WalkContext,
): unknown {
  const shapes = SUBSCHEMA_KEYWORDS.get(keyword)
  if (shapes === undefined) return value
  if (shapes.includes("single") && isPlainObject(value)) {
    return walk(value, `${path}.${keyword}`, depth + 1, ctx)
  }
  if (shapes.includes("array") && Array.isArray(value)) {
    let changed: unknown[] | undefined
    for (const [index, sub] of value.entries()) {
      if (!isPlainObject(sub)) continue
      const walked = walk(sub, `${path}.${keyword}[${index}]`, depth + 1, ctx)
      if (walked === sub) continue
      changed ??= value.slice()
      changed[index] = walked
    }
    return changed ?? value
  }
  if (shapes.includes("map") && isPlainObject(value)) {
    let changed: Record<string, unknown> | undefined
    for (const [index, [key, sub]] of Object.entries(value).entries()) {
      if (!isPlainObject(sub)) continue
      const walked = walk(sub, `${path}.${mapSegment(keyword, key, index)}`, depth + 1, ctx)
      if (walked === sub) continue
      changed ??= copyOf(value)
      defineOn(changed, key, walked)
    }
    return changed ?? value
  }
  return value
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
  ctx.budget.nodes += 1
  if (ctx.budget.nodes > MAX_SCHEMA_NODES) {
    rejectField(path, `takes the request's tool schemas past ${MAX_SCHEMA_NODES} walked subschemas`)
  }
  let next: Record<string, unknown> | undefined

  if (typeof schema.pattern === "string" && LOOKAROUND.test(schema.pattern)) {
    next = copyOf(schema)
    delete next.pattern
    ctx.onDrop({ field: `${path}.pattern`, reason: ctx.reason })
  }

  // Dispatch on the node's own keys: a node pays for the keywords it has, not for the whole table.
  for (const key of Object.keys(schema)) {
    const value = schema[key]
    const walked = walkKeyword(key, value, path, depth, ctx)
    if (walked === value) continue
    next ??= copyOf(schema)
    defineOn(next, key, walked)
  }

  return next ?? schema
}

/**
 * Strip lookaround `pattern`s from every `tools[i].parameters` schema of a Responses body. The body
 * and a tool are rebuilt only when something under them changed; otherwise the input is returned.
 * A schema whose serialized text holds no lookaround anywhere is not walked at all.
 *
 * @throws TranslationError when a walked schema nests deeper than {@link MAX_SCHEMA_DEPTH}, or the
 *   walked schemas together hold more than {@link MAX_SCHEMA_NODES} subschemas.
 */
export function stripLookaroundPatternsFromTools(
  body: Record<string, unknown>,
  onDrop: DropSink,
): Record<string, unknown> {
  const tools = body.tools
  if (!Array.isArray(tools)) return body
  let nextTools: unknown[] | undefined
  const budget = { nodes: 0 }
  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool) || !isPlainObject(tool.parameters)) continue
    const name = typeof tool.name === "string" ? tool.name : `tools[${index}]`
    const reason = `the target account's Responses surface cannot compile regex lookarounds in tool schemas (tool \`${name}\`)`
    const parameters = tool.parameters
    // Most tools carry no lookaround anywhere: one serialization skips the walk and its copies.
    if (!LOOKAROUND.test(JSON.stringify(parameters))) continue
    const walked = walk(parameters, `tools[${index}].parameters`, 0, { reason, onDrop, budget })
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
