/**
 * Whether a JSON Schema can travel as Anthropic's native `output_config.format` json_schema.
 *
 * Native is an optimisation, never a requirement: a schema refused here rides the adapted
 * structured-output tool (`tool-choice.ts`), which needs no grammar. So every rule below errs
 * towards "not native". Pure; a schema that is not an object is not native.
 *
 * 1. **Every object node is closed.** `output_config.format.schema: For 'object' type,
 *    'additionalProperties' must be explicitly set to false` (claude-opus-5-5 through a Claude
 *    subscription on the fast transport, 2026-11-09, #370). A node is an object when its `type` is
 *    or lists `"object"`, or when it declares `properties` without a type.
 * 2. **Only the documented subset** — a backstop: `tool-choice.ts` first reduces the client's schema
 *    to that subset (`anthropic-output-schema.ts`), so these keywords normally never arrive here.
 *    Anthropic's structured outputs refuse numeric bounds, string
 *    length bounds, array bounds beyond `minItems` 0/1, and the conditional / dependent / tuple
 *    keywords. Prod 2026-11-08…10 (101 finding 10.4): 13 × `output_config.format.schema: For
 *    'array' type, property 'maxItems' is not supported` in 0.13–0.2 s.
 * 3. **No recursion.** A `$ref` must resolve to a local `$defs` / `definitions` entry, and no
 *    entry may reach itself; the root reference `#` is recursion by definition.
 * 4. **Inside the complexity budget.** Anthropic compiles a grammar per schema and rejects one that
 *    is too large only after the compile gives up. Prod 2026-11-09…10: 46 × `Schema is too
 *    complex.` and 2 × `Grammar compilation timed out`, each after ~180 s — a client held three
 *    minutes for a 400. The budget refuses the shapes that compile slowly before anything is sent.
 */
export function nativeStructuredSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  const defs = definitionsOf(schema)
  const budget: Budget = { nodes: 0, optional: 0, unions: 0 }
  return walk(schema, 0, defs, budget) && !recursive(defs) && withinBudget(budget)
}

/**
 * Provenance: Anthropic structured-outputs documentation, "Schema complexity limits" (24 optional
 * properties and 16 union-typed properties across one request's schemas) — pinned here as the
 * upstream's own published ceilings. Blast radius: if Anthropic lowers them, schemas between the
 * old and new ceilings fail natively with a fast `400` and are retried on the tool path by the
 * invoker; if it raises them, they keep riding the tool path, which is correct, just not native.
 */
const MAX_OPTIONAL_PROPERTIES = 24
const MAX_UNION_PROPERTIES = 16
/**
 * Not a published number: a ceiling on schema nodes walked, chosen well under what the 180 s
 * compile failures implied, so a large generated schema rides the tool path instead of the grammar
 * compiler. Raising it trades fewer tool-path answers for more risk of a slow native compile.
 */
const MAX_NODES = 200
/** A schema nested deeper than this is not trusted; it rides the forced tool. */
const MAX_DEPTH = 32

/** Keywords Anthropic's structured outputs refuse outright, whatever their value. */
const REFUSED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "unevaluatedProperties",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "if",
  "then",
  "else",
  "not",
  "oneOf",
  "contentSchema",
  "$dynamicRef",
  "$recursiveRef",
])

/** Keys whose value is one subschema the walk descends into. */
const SINGLE = ["items", "additionalProperties"] as const
/** Keys whose value is a list of subschemas. */
const LISTS = ["anyOf", "allOf"] as const
/** Keys whose value maps names to subschemas. */
const MAPS = ["properties", "$defs", "definitions"] as const

interface Budget {
  nodes: number
  optional: number
  unions: number
}

function walk(
  node: Record<string, unknown>,
  depth: number,
  defs: ReadonlyMap<string, Record<string, unknown>>,
  budget: Budget,
): boolean {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) return false
  if (isObjectNode(node) && node.additionalProperties !== false) return false
  for (const key of Object.keys(node)) if (REFUSED.has(key)) return false
  if (typeof node.minItems === "number" && node.minItems > 1) return false
  if (Array.isArray(node.items)) return false
  // Only a local definition: the root `#`, a remote ref or a dangling one is not native.
  if (typeof node.$ref === "string" && !defs.has(node.$ref)) return false
  if (Array.isArray(node.type) || Array.isArray(node.anyOf)) budget.unions++
  if (isRecord(node.properties)) {
    const required = Array.isArray(node.required) ? new Set(node.required) : new Set()
    for (const name of Object.keys(node.properties)) if (!required.has(name)) budget.optional++
  }
  const children: unknown[] = []
  for (const key of SINGLE) if (isRecord(node[key])) children.push(node[key])
  for (const key of LISTS) {
    const value = node[key]
    if (Array.isArray(value)) children.push(...value)
  }
  for (const key of MAPS) {
    const value = node[key]
    if (isRecord(value)) children.push(...Object.values(value))
  }
  return children.every((child) => !isRecord(child) || walk(child, depth + 1, defs, budget))
}

function withinBudget(budget: Budget): boolean {
  return budget.optional <= MAX_OPTIONAL_PROPERTIES && budget.unions <= MAX_UNION_PROPERTIES
}

/** The root's local definitions, keyed by the `$ref` pointer that names each. */
function definitionsOf(root: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const defs = new Map<string, Record<string, unknown>>()
  for (const key of ["$defs", "definitions"] as const) {
    const value = root[key]
    if (!isRecord(value)) continue
    for (const [name, schema] of Object.entries(value))
      if (isRecord(schema)) defs.set(`#/${key}/${name}`, schema)
  }
  return defs
}

/** Whether any definition reaches itself through `$ref`s (depth-first, three colours). */
function recursive(defs: ReadonlyMap<string, Record<string, unknown>>): boolean {
  const state = new Map<string, "open" | "done">()
  const visit = (name: string): boolean => {
    const seen = state.get(name)
    if (seen === "open") return true
    if (seen === "done") return false
    state.set(name, "open")
    const schema = defs.get(name)
    const cyclic = schema !== undefined && refsIn(schema).some((ref) => defs.has(ref) && visit(ref))
    state.set(name, "done")
    return cyclic
  }
  return [...defs.keys()].some(visit)
}

/** Every `$ref` string anywhere under a node. */
function refsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) refsIn(item, out)
  else if (isRecord(node))
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") out.push(value)
      else refsIn(value, out)
    }
  return out
}

function isObjectNode(node: Record<string, unknown>): boolean {
  const type = node.type
  if (type === "object") return true
  if (Array.isArray(type)) return type.includes("object")
  return type === undefined && isRecord(node.properties)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
