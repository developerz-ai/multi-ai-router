import type { DropSink } from "./drops"

/**
 * What a particular OpenAI Responses *surface* demands of a body the router writes for it.
 *
 * The Responses dialect is one wire shape, but not every upstream speaking it accepts all of it.
 * The ChatGPT Codex backend refuses a non-streaming request, refuses one without `instructions`,
 * and refuses sampling and ceiling fields its first-party client never sends. Those are facts about
 * the upstream, so the **driver** declares them (`providers/drivers/*`) and the translator reads
 * them from its context — no provider name is ever tested in this directory (non-negotiable 12),
 * and the translator stays a pure function of body + rules (non-negotiable 9).
 *
 * Applied only to bodies the router *wrote* — a cross-dialect request. A same-dialect `/v1/responses`
 * body is a byte relay and is never parsed to apply these (non-negotiable 10).
 */
export interface ResponsesEgressRules {
  /** The upstream answers only as SSE: `stream` is sent `true` whatever the client asked. */
  readonly requireStream: boolean
  /** The upstream rejects a body with no `instructions`; an absent prompt is sent as `""`. */
  readonly requireInstructions: boolean
  /** Top-level Responses fields the upstream refuses. Removed, and reported by name. */
  readonly unsupportedFields: readonly string[]
  /**
   * The upstream compiles a JSON-Schema `pattern` and refuses a regex lookaround (`(?=`, `(?!`,
   * `(?<=`, `(?<!`) with `400`. When true, every `pattern` in known schema positions — `properties`,
   * `patternProperties` subschemas, `propertyNames`, `if`/`then`/`else`, `dependentSchemas`,
   * `contains`, the array form of `items` — is checked for a lookaround and stripped when it has
   * one; the drop is reported by tool name and schema path, never by pattern value.
   *
   * `default` / `enum` / `examples` / `const` data are not walked — a `default` carrying a lookaround
   * is data, not a schema. `patternProperties` regex keys are deliberately out of scope. The
   * parser's source is reused across failovers, so the input is copied rather than edited
   * (`dataplane/translate-body.ts`).
   */
  readonly stripToolPatterns: boolean
}

export const DEFAULT_RESPONSES_EGRESS: ResponsesEgressRules = {
  requireStream: false,
  requireInstructions: false,
  unsupportedFields: [],
  stripToolPatterns: false,
}

const REFUSED_BY_SURFACE = "the target account's Responses surface refuses this field"
const LOOKAROUND_REASON = "the Codex backend cannot compile regex lookarounds in tool schemas"

/**
 * A regex containing a lookaround. Matched as a substring — over-matches escaped `\(?=` and the
 * character class `[(?=]`, both of which Codex would accept, so a value that would otherwise pass
 * is dropped here. The trade-off is one validation hint, reported by name.
 */
const LOOKAROUND_PATTERN = /\(\?[=!<]/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasLookaroundPattern(value: unknown): boolean {
  return typeof value === "string" && LOOKAROUND_PATTERN.test(value)
}

/**
 * Walk the explicit schema keywords named in `stripToolPatterns`'s doc — `properties.<key>`,
 * `patternProperties` subschema values, `propertyNames`, `if`/`then`/`else`, `dependentSchemas`,
 * `contains`, the array form of `items`. Never a blind deep walk, so `default` / `enum` / `examples`
 * / `const` data strings survive even when they contain a lookaround. `patternProperties` regex
 * keys are deliberately out of scope.
 *
 * The input is never mutated; the returned object is the same reference when nothing changed,
 * so the caller can compare with `===`.
 */
function stripLookaroundsFromSchema(
  schema: Record<string, unknown>,
  basePath: string,
  toolName: string,
  onDrop: DropSink,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null

  // 1. This node's own `pattern`.
  if (hasLookaroundPattern(schema.pattern)) {
    if (next === null) next = { ...schema }
    delete next.pattern
    onDrop({
      field: `${basePath}.pattern`,
      reason: `${LOOKAROUND_REASON} (tool \`${toolName}\`)`,
    })
  }

  // 2. `properties.<key>` — each value is a subschema.
  const properties = schema.properties
  if (isPlainObject(properties)) {
    const nextProps: Record<string, unknown> = {}
    let propsChanged = false
    for (const [key, value] of Object.entries(properties)) {
      if (isPlainObject(value)) {
        const sub = stripLookaroundsFromSchema(
          value,
          `${basePath}.properties.${key}`,
          toolName,
          onDrop,
        )
        if (sub !== value) propsChanged = true
        nextProps[key] = sub
      } else {
        nextProps[key] = value
      }
    }
    if (propsChanged) {
      if (next === null) next = { ...schema }
      next.properties = nextProps
    }
  }

  // 3. `patternProperties.<key>` — subschema VALUES only. Keys are regex strings; out of scope.
  const patternProperties = schema.patternProperties
  if (isPlainObject(patternProperties)) {
    const nextPp: Record<string, unknown> = {}
    let ppChanged = false
    for (const [key, value] of Object.entries(patternProperties)) {
      if (isPlainObject(value)) {
        const sub = stripLookaroundsFromSchema(
          value,
          `${basePath}.patternProperties.${key}`,
          toolName,
          onDrop,
        )
        if (sub !== value) ppChanged = true
        nextPp[key] = sub
      } else {
        nextPp[key] = value
      }
    }
    if (ppChanged) {
      if (next === null) next = { ...schema }
      next.patternProperties = nextPp
    }
  }

  // 4. `propertyNames` — a single subschema.
  if (isPlainObject(schema.propertyNames)) {
    const sub = stripLookaroundsFromSchema(
      schema.propertyNames,
      `${basePath}.propertyNames`,
      toolName,
      onDrop,
    )
    if (sub !== schema.propertyNames) {
      if (next === null) next = { ...schema }
      next.propertyNames = sub
    }
  }

  // 5. `if` / `then` / `else` — each is a single subschema.
  for (const keyword of ["if", "then", "else"] as const) {
    if (isPlainObject(schema[keyword])) {
      const sub = stripLookaroundsFromSchema(
        schema[keyword],
        `${basePath}.${keyword}`,
        toolName,
        onDrop,
      )
      if (sub !== schema[keyword]) {
        if (next === null) next = { ...schema }
        next[keyword] = sub
      }
    }
  }

  // 6. `dependentSchemas.<key>` — each value is a subschema.
  const dependentSchemas = schema.dependentSchemas
  if (isPlainObject(dependentSchemas)) {
    const nextDs: Record<string, unknown> = {}
    let dsChanged = false
    for (const [key, value] of Object.entries(dependentSchemas)) {
      if (isPlainObject(value)) {
        const sub = stripLookaroundsFromSchema(
          value,
          `${basePath}.dependentSchemas.${key}`,
          toolName,
          onDrop,
        )
        if (sub !== value) dsChanged = true
        nextDs[key] = sub
      } else {
        nextDs[key] = value
      }
    }
    if (dsChanged) {
      if (next === null) next = { ...schema }
      next.dependentSchemas = nextDs
    }
  }

  // 7. `contains` — a single subschema.
  if (isPlainObject(schema.contains)) {
    const sub = stripLookaroundsFromSchema(
      schema.contains,
      `${basePath}.contains`,
      toolName,
      onDrop,
    )
    if (sub !== schema.contains) {
      if (next === null) next = { ...schema }
      next.contains = sub
    }
  }

  // 8. `items` — array form only. The single-form `items` is the parent's schema in a different
  //    position; its `pattern` is reached via the parent.
  if (Array.isArray(schema.items)) {
    const items = schema.items
    const nextItems: unknown[] = items.slice()
    let itemsChanged = false
    for (const [index, value] of items.entries()) {
      if (isPlainObject(value)) {
        const sub = stripLookaroundsFromSchema(
          value,
          `${basePath}.items[${index}]`,
          toolName,
          onDrop,
        )
        if (sub !== value) {
          nextItems[index] = sub
          itemsChanged = true
        }
      }
    }
    if (itemsChanged) {
      if (next === null) next = { ...schema }
      next.items = nextItems
    }
  }

  return next ?? schema
}

/**
 * Strip regex-lookaround `pattern` values from every tool's schema when the surface demands it.
 * The tool object is rebuilt only when its `parameters` changed, and `parameters` only when a
 * nested strip ran, so a body without lookarounds returns the original reference.
 */
function stripToolPatternsFromBody(
  body: Record<string, unknown>,
  onDrop: DropSink,
): Record<string, unknown> {
  const tools = body.tools
  if (!Array.isArray(tools)) return body
  let mutated = false
  const nextTools: unknown[] = tools.slice()
  for (const [index, value] of tools.entries()) {
    if (!isPlainObject(value)) continue
    const toolName = typeof value.name === "string" ? value.name : `tool[${index}]`
    const params = value.parameters
    if (!isPlainObject(params)) continue
    const stripped = stripLookaroundsFromSchema(
      params,
      `tools[${index}].parameters`,
      toolName,
      onDrop,
    )
    if (stripped !== params) {
      nextTools[index] = { ...value, parameters: stripped }
      mutated = true
    }
  }
  if (!mutated) return body
  return { ...body, tools: nextTools }
}

export function applyResponsesEgressRules(
  body: unknown,
  rules: ResponsesEgressRules | undefined,
  onDrop: DropSink | undefined,
): unknown {
  if (rules === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
    return body
  }
  let out: Record<string, unknown> = { ...body }
  for (const field of rules.unsupportedFields) {
    if (out[field] === undefined) continue
    delete out[field]
    onDrop?.({ field, reason: REFUSED_BY_SURFACE })
  }
  if (rules.requireStream) out.stream = true
  if (rules.requireInstructions && typeof out.instructions !== "string") out.instructions = ""
  if (rules.stripToolPatterns && onDrop !== undefined) {
    out = stripToolPatternsFromBody(out, onDrop)
  } else if (rules.stripToolPatterns) {
    // Build a no-op drop sink: the rules ask for the strip, the caller just didn't pass one.
    out = stripToolPatternsFromBody(out, () => undefined)
  }
  return out
}
