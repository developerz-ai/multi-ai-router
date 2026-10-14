import type { OpenAiResponsesTextFormat } from "./openai-responses"
import { rejectField } from "./reject"

/**
 * openai-chat's `response_format` → openai-responses' `text.format`: the one crossing where both
 * sides state structured output, so the constraint is **carried** rather than refused.
 *
 * The two spellings are one feature one dialect apart. Chat nests the schema under `json_schema`;
 * Responses flattens the same four members onto the format object itself:
 *
 * | openai-chat `response_format` | openai-responses `text.format` |
 * |---|---|
 * | `{type: "text"}` / absent | nothing — the default, constrains nothing |
 * | `{type: "json_object"}` | `{type: "json_object"}` |
 * | `{type: "json_schema", json_schema: {name, schema, strict?, description?}}` | `{type: "json_schema", name, schema, strict?, description?}` |
 *
 * Every value travels verbatim — the schema object is the caller's own reference, never rebuilt —
 * because the caller will parse the answer against exactly that schema, and a schema we normalized
 * is a different contract. Anything else (`grammar`, a type OpenAI adds later) is refused by name:
 * this build has no reading of it to carry.
 *
 * **`name` is required on Responses and optional-looking on Chat**, so it is validated the way
 * OpenAI validates it (`^[a-zA-Z0-9_-]{1,64}$`) and, when the caller sent none, defaulted to
 * {@link DEFAULT_SCHEMA_NAME}. A missing `schema` is refused: Responses requires one, and inventing
 * `{}` would promise the caller a constraint nobody stated. Pure, and every refusal names a field
 * and never a value (`shared/reject.ts`).
 */

/**
 * The name sent when openai-chat's `json_schema` named none. The model can see the name, so it is a
 * neutral word that steers nothing; it is never echoed back to the caller.
 */
export const DEFAULT_SCHEMA_NAME = "response"

/** OpenAI's own rule for `json_schema.name`, on both surfaces. */
const SCHEMA_NAME = /^[a-zA-Z0-9_-]{1,64}$/

const FIELD = "response_format"

export function responseFormatToResponsesText(
  responseFormat: { readonly type: string } | null | undefined,
): { readonly format: OpenAiResponsesTextFormat } | undefined {
  if (responseFormat === null || responseFormat === undefined) return undefined
  switch (responseFormat.type) {
    case "text":
      return undefined
    case "json_object":
      return { format: { type: "json_object" } }
    case "json_schema":
      return { format: jsonSchemaFormat((responseFormat as { json_schema?: unknown }).json_schema) }
    default:
      // The unknown word is not quoted back: it is a free string out of a refused body.
      rejectField(
        `${FIELD}.type`,
        "names a structured-output type this build cannot carry onto openai-responses; it carries `text`, `json_object` and `json_schema`",
      )
  }
}

function jsonSchemaFormat(spec: unknown): OpenAiResponsesTextFormat {
  const at = `${FIELD}.json_schema`
  if (!isPlainObject(spec)) rejectField(at, "must be an object when `type` is `json_schema`")

  const name = spec.name ?? DEFAULT_SCHEMA_NAME
  if (typeof name !== "string" || !SCHEMA_NAME.test(name)) {
    rejectField(`${at}.name`, "must be 1-64 characters of a-z, A-Z, 0-9, `_` or `-`")
  }
  const schema = spec.schema
  if (!isPlainObject(schema)) {
    rejectField(
      `${at}.schema`,
      "must be a JSON Schema object: openai-responses requires one, and an invented schema would promise a constraint the caller never stated",
    )
  }
  const strict = spec.strict
  if (strict !== undefined && strict !== null && typeof strict !== "boolean") {
    rejectField(`${at}.strict`, "must be a boolean")
  }
  const description = spec.description
  if (description !== undefined && description !== null && typeof description !== "string") {
    rejectField(`${at}.description`, "must be a string")
  }

  return {
    type: "json_schema",
    name,
    schema,
    // `null` is Chat's spelling of "unset"; absent is Responses'. The upstream default applies.
    ...(typeof strict === "boolean" ? { strict } : {}),
    ...(typeof description === "string" ? { description } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
