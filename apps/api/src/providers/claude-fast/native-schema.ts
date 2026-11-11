/**
 * Whether a JSON Schema can travel as Anthropic's native `output_config.format` json_schema.
 *
 * Anthropic refuses an object node that leaves `additionalProperties` open:
 * `output_config.format.schema: For 'object' type, 'additionalProperties' must be explicitly set
 * to false` (claude-opus-5-5 through a Claude subscription on the fast transport, 2026-11-09,
 * #370). So every object node — the root and every nested schema under properties, items,
 * combinators, definitions or an `additionalProperties` sub-schema — must state
 * `additionalProperties: false`. A node is an object when its `type` is or lists `"object"`, or
 * when it declares `properties` without a type. Pure; a schema that is not an object is not native.
 */
export function nativeStructuredSchema(schema: unknown): boolean {
  return isRecord(schema) && closedEverywhere(schema, 0)
}

/** Keys whose value is one subschema. */
const SINGLE = [
  "items",
  "additionalProperties",
  "additionalItems",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "contentSchema",
  "not",
  "if",
  "then",
  "else",
  "contains",
] as const
/** Keys whose value is a list of subschemas. */
const LISTS = ["anyOf", "oneOf", "allOf", "prefixItems", "items"] as const
/** Keys whose value maps names to subschemas. */
const MAPS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
] as const
/** A schema nested deeper than this is not trusted to be closed; it rides the forced tool. */
const MAX_DEPTH = 64

function closedEverywhere(node: Record<string, unknown>, depth: number): boolean {
  if (depth > MAX_DEPTH) return false
  if (isObjectNode(node) && node.additionalProperties !== false) return false
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
  return children.every((child) => !isRecord(child) || closedEverywhere(child, depth + 1))
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
