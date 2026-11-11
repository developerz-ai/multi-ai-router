import type { DropSink } from "./drops"
import { isRecord } from "./is-record"
import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES, schemaPathSegment } from "./schema-lookarounds"

/**
 * A client JSON Schema reduced to the subset Anthropic's native `output_config.format` compiles.
 *
 * Anthropic refuses a constrained-output schema that uses a keyword outside its subset, either fast
 * (`For 'array' type, property 'maxItems' is not supported`, prod 2026-11-09…10, 13 requests) or
 * after a long grammar compile. The subset is the one Anthropic's own SDKs send
 * (`@anthropic-ai/sdk` `lib/transform-json-schema.ts`, read at 0.131.0) and its structured-output
 * docs list: `type`, `description`, `title`, `enum`, `const`, `anyOf`, `allOf`, `$ref`, `$defs` /
 * `definitions`, `properties`, `required`, `additionalProperties`, `items` (one schema),
 * `minItems` of 0 or 1, and `format` from {@link SUPPORTED_FORMATS}. Blast radius if Anthropic
 * widens or narrows it: this table only.
 *
 * Everything else is removed and, like the SDK does, restated as text in the node's `description`
 * so the model still reads the constraint; the caller validates against its own full schema anyway.
 * A constraint keyword is reported through `onDrop` by path; an annotation (`$schema`, `examples`,
 * `default`, …) is a hint and goes silently (`shared/drops.ts`). `oneOf` is carried as `anyOf`, the
 * SDK's own reading, and reported because exclusivity is lost.
 *
 * Not closed here: an object node whose `additionalProperties` is not `false` is left as it is, and
 * the caller's `nativeStructuredSchema` keeps such a schema off the native path — closing it would
 * forbid keys the caller allowed. Pure; never mutates its input; an unchanged schema comes back as
 * the same reference.
 *
 * Returns null when the schema nests deeper than {@link MAX_SCHEMA_DEPTH} or holds more than
 * {@link MAX_SCHEMA_NODES} subschemas: such a schema is not one to hand a grammar compiler, and the
 * caller keeps its non-native path.
 */
export interface AnthropicOutputSchema {
  readonly schema: Record<string, unknown>
  /** Subschemas walked; a size signal for the caller's complexity gate. */
  readonly nodes: number
  /** Properties not listed in their object's `required`, summed over every object node. */
  readonly optionalProperties: number
  /** Nodes that branch: `anyOf` / `oneOf`, or a `type` array. */
  readonly unions: number
}

export const DEFAULT_OUTPUT_SCHEMA_PATH = "response_format.json_schema.schema"

/** The string formats Anthropic's constrained decoding knows. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
])

/** Kept as they are: plain values, or handled by the walk below. */
const KEPT: ReadonlySet<string> = new Set([
  "type",
  "description",
  "title",
  "enum",
  "const",
  "$ref",
  "required",
  "additionalProperties",
])

/** Schema metadata: removed without a report, never restated. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$comment",
  "$anchor",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
])

const REASON =
  "is outside the JSON Schema subset Anthropic's native structured output compiles; restated in the description instead"

interface Walk {
  readonly onDrop: DropSink
  nodes: number
  optionalProperties: number
  unions: number
}

export function anthropicOutputSchema(
  schema: Record<string, unknown>,
  onDrop: DropSink,
  path: string = DEFAULT_OUTPUT_SCHEMA_PATH,
): AnthropicOutputSchema | null {
  const walk: Walk = { onDrop, nodes: 0, optionalProperties: 0, unions: 0 }
  const out = node(schema, path, 0, walk)
  if (out === null) return null
  return {
    schema: out,
    nodes: walk.nodes,
    optionalProperties: walk.optionalProperties,
    unions: walk.unions,
  }
}

function node(
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  walk: Walk,
): Record<string, unknown> | null {
  walk.nodes += 1
  if (depth > MAX_SCHEMA_DEPTH || walk.nodes > MAX_SCHEMA_NODES) return null
  count(schema, walk)

  const out: Record<string, unknown> = {}
  const restated: string[] = []
  let changed = false
  const drop = (key: string, value: unknown, report: boolean) => {
    changed = true
    if (report) {
      restated.push(`${key}: ${JSON.stringify(value)}`)
      walk.onDrop({ field: `${path}.${key}`, reason: REASON })
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (KEPT.has(key)) define(out, key, value)
    else if (ANNOTATIONS.has(key)) drop(key, value, false)
    else if (key === "format" && typeof value === "string" && SUPPORTED_FORMATS.has(value))
      define(out, key, value)
    else if (key === "minItems" && (value === 0 || value === 1)) define(out, key, value)
    else if (key === "items" && isRecord(value)) {
      const items = node(value, `${path}.items`, depth + 1, walk)
      if (items === null) return null
      changed ||= items !== value
      define(out, key, items)
    } else if ((key === "anyOf" || key === "allOf" || key === "oneOf") && Array.isArray(value)) {
      const target = key === "oneOf" ? "anyOf" : key
      if (key === "oneOf") {
        changed = true
        walk.onDrop({
          field: `${path}.oneOf`,
          reason:
            "is carried as `anyOf` on Anthropic's native structured output, which states no exclusive union",
        })
      }
      const branches = list(value, `${path}.${key}`, depth, walk)
      if (branches === null) return null
      changed ||= branches !== value
      define(out, target, branches)
    } else if (
      (key === "properties" || key === "$defs" || key === "definitions") &&
      isRecord(value)
    ) {
      const mapped = map(value, path, key, depth, walk)
      if (mapped === null) return null
      changed ||= mapped !== value
      define(out, key, mapped)
    } else drop(key, value, true)
  }

  if (restated.length > 0) {
    const existing = typeof out.description === "string" ? `${out.description}\n\n` : ""
    define(out, "description", `${existing}{${restated.join(", ")}}`)
  }
  return changed ? out : schema
}

function list(value: readonly unknown[], at: string, depth: number, walk: Walk): unknown[] | null {
  let changed: unknown[] | undefined
  for (const [index, sub] of value.entries()) {
    if (!isRecord(sub)) continue
    const next = node(sub, `${at}[${index}]`, depth + 1, walk)
    if (next === null) return null
    if (next === sub) continue
    changed ??= value.slice()
    changed[index] = next
  }
  return changed ?? (value as unknown[])
}

function map(
  value: Record<string, unknown>,
  path: string,
  keyword: string,
  depth: number,
  walk: Walk,
): Record<string, unknown> | null {
  let changed: Record<string, unknown> | undefined
  for (const [index, [key, sub]] of Object.entries(value).entries()) {
    if (!isRecord(sub)) continue
    const next = node(sub, `${path}.${schemaPathSegment(keyword, key, index)}`, depth + 1, walk)
    if (next === null) return null
    if (next === sub) continue
    changed ??= Object.fromEntries(Object.entries(value))
    define(changed, key, next)
  }
  return changed ?? value
}

function count(schema: Record<string, unknown>, walk: Walk): void {
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.type))
    walk.unions += 1
  if (!isRecord(schema.properties)) return
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  for (const key of Object.keys(schema.properties))
    if (!required.has(key)) walk.optionalProperties += 1
}

/** CreateDataProperty, not [[Set]]: a `__proto__` key in client data stays an own key. */
function define(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}
