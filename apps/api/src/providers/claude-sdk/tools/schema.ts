import { z } from "zod"

/**
 * A client's JSON Schema, read into the Zod raw shape the Agent SDK's MCP registration demands.
 *
 * The direction is forced on us. Every other seam in this codebase carries a tool declaration as
 * JSON Schema, because that is what both wire protocols speak — but `createSdkMcpServer` registers
 * tools through `McpServer.registerTool`, whose `inputSchema` is a **Zod raw shape**, which the MCP
 * server then serializes back to JSON Schema for the model. So the client's schema has to make a
 * round trip through Zod, and this module is the outbound half of it.
 *
 * **Anything unrepresentable degrades to `z.unknown()` rather than failing the request.** A tool
 * schema is the client's business, not ours: refusing a request because a JSON Schema keyword did
 * not survive our reader would turn a fidelity gap into an outage, and the model can still call a
 * loosely-typed tool. The one thing never done is *inventing* a constraint the client did not state
 * — a property we cannot read becomes unconstrained, never guessed.
 *
 * Pure and total: no clock, no I/O, and nothing here throws (non-negotiable 9).
 */

/**
 * How deep a client schema is followed before the rest becomes `z.unknown()`.
 *
 * A bound, not a tuning knob: schemas arrive from callers, and a self-referential `$ref`-free
 * structure nested a thousand deep would otherwise be a stack overflow reachable from any key.
 */
const MAX_DEPTH = 8

export interface ToolSchema {
  /** Hand straight to `tool()`. Property order follows the client's declaration. */
  readonly shape: z.ZodRawShape
  /** Declared `required` names, in declaration order. The only names param repair may rename to. */
  readonly required: readonly string[]
  /** Every declared top-level property name. */
  readonly properties: readonly string[]
}

/**
 * @param input an Anthropic tool's `input_schema`. Anything that is not an object schema reads as a
 * tool taking no declared arguments — which is what a missing schema means, not an error.
 */
export function readToolSchema(input: unknown): ToolSchema {
  const node = isRecord(input) ? input : {}
  const properties = isRecord(node.properties) ? node.properties : {}
  const required = readNames(node.required)
  const requiredSet = new Set(required)

  const entries = Object.entries(properties).map(([name, value]) => {
    const field = convert(value, 1)
    return [name, requiredSet.has(name) ? field : field.optional()] as const
  })

  // `Object.fromEntries`, never `shape[name] = …`: the names come from a caller, and assigning to
  // `__proto__` on a plain object runs the inherited setter instead of defining a property.
  return { shape: Object.fromEntries(entries), required, properties: Object.keys(properties) }
}

function convert(node: unknown, depth: number): z.ZodType {
  if (!isRecord(node) || depth > MAX_DEPTH) return z.unknown()
  const described = base(node, depth)
  const description = node.description
  return typeof description === "string" ? described.describe(description) : described
}

function base(node: Record<string, unknown>, depth: number): z.ZodType {
  if ("const" in node) return literal(node.const)

  const choices = readArray(node.enum)
  if (choices !== null) return enumOf(choices)

  const composite = readArray(node.anyOf) ?? readArray(node.oneOf)
  if (composite !== null) return anyOf(composite.map((part) => convert(part, depth + 1)))

  const types = readNames(node.type)
  return anyOf(types.map((type) => byType(type, node, depth)))
}

function byType(type: string, node: Record<string, unknown>, depth: number): z.ZodType {
  switch (type) {
    case "string":
      return z.string()
    case "integer":
      return z.number().int()
    case "number":
      return z.number()
    case "boolean":
      return z.boolean()
    case "null":
      return z.null()
    case "array":
      return z.array(convert(node.items, depth + 1))
    case "object":
      return objectOf(node, depth)
    default:
      return z.unknown()
  }
}

function objectOf(node: Record<string, unknown>, depth: number): z.ZodType {
  const properties = isRecord(node.properties) ? node.properties : {}
  const required = new Set(readNames(node.required))
  const entries = Object.entries(properties).map(([name, value]) => {
    const field = convert(value, depth + 1)
    return [name, required.has(name) ? field : field.optional()] as const
  })
  const shape = Object.fromEntries(entries)
  // Only an explicit `additionalProperties: false` closes the object. Absent means unconstrained in
  // JSON Schema, and reading absence as "closed" would narrow a tool the client left open.
  return node.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape)
}

/**
 * A JSON Schema `enum`.
 *
 * All-string choices become a Zod enum rather than a union of literals, because that is what
 * serializes back to `enum: [...]` — the shorter of the two forms, and the tool catalogue it lands
 * in is charged to the caller as input tokens on every turn.
 */
function enumOf(choices: readonly unknown[]): z.ZodType {
  if (choices.length > 0 && choices.every((choice) => typeof choice === "string")) {
    return z.enum([...choices])
  }
  return anyOf(choices.map(literal))
}

/** A JSON Schema `const`/`enum` member. Only primitives have a Zod literal; the rest go unread. */
function literal(value: unknown): z.ZodType {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value)
  }
  if (value === null) return z.null()
  return z.unknown()
}

/** Zod's union needs two members; one alternative is that alternative, and none is unconstrained. */
function anyOf(parts: readonly z.ZodType[]): z.ZodType {
  const [first, second] = parts
  if (first === undefined) return z.unknown()
  if (second === undefined) return first
  return z.union([first, second, ...parts.slice(2)])
}

/** A JSON Schema field that is a name, a list of names, or absent. Non-strings are dropped. */
function readNames(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
