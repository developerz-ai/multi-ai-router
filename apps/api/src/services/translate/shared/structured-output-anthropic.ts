import type { AnthropicTool, AnthropicToolChoice } from "./anthropic"
import { rejectField } from "./reject"

/**
 * openai-chat's `response_format` → Anthropic, which states no such field: structured output there
 * is a **forced tool call**, the standard technique and the only one the dialect offers.
 *
 * | openai-chat `response_format` | anthropic |
 * |---|---|
 * | `{type: "text"}` / absent | nothing — the default, constrains nothing |
 * | `{type: "json_object"}` | one tool whose `input_schema` is `{type: "object"}`, forced |
 * | `{type: "json_schema", json_schema: {schema, description?}}` | one tool whose `input_schema` is `schema`, forced |
 *
 * The tool is named {@link STRUCTURED_OUTPUT_TOOL}, a fixed word, because the response half
 * (`anthropic-to-openai-chat/response.ts`, `stream.ts`) is a pure function of the upstream body and
 * must recognize the call without being told what the request asked: a `tool_use` of that name is
 * the answer, so its `input` becomes `message.content` as a JSON string and it is not a tool call
 * to the client. That is sound only while no client tool can carry the name, so a request declaring
 * one is refused ({@link assertNoReservedTool}), and while the client's own tools are absent from a
 * request that forces this one, so tools beside a structured-output constraint are refused too.
 *
 * Forcing a tool is incompatible with thinking on Anthropic's API and on compatible upstreams, so
 * the caller states `thinking: {type: "disabled"}` whenever the choice is forced
 * (`forcesToolUse`). Pure; every refusal names a field and never a value (`shared/reject.ts`).
 */
export const STRUCTURED_OUTPUT_TOOL = "router_structured_output"

const DEFAULT_DESCRIPTION =
  "Deliver the final answer by calling this tool once. The arguments are the answer itself."

const FIELD = "response_format"

export interface StructuredOutputFields {
  readonly tools: AnthropicTool[]
  readonly tool_choice: AnthropicToolChoice
}

export function structuredOutputToAnthropic(
  responseFormat: { readonly type: string } | null | undefined,
  clientTools: readonly unknown[] | undefined,
): StructuredOutputFields | undefined {
  if (responseFormat === null || responseFormat === undefined) return undefined
  if (responseFormat.type === "text") return undefined

  let tool: AnthropicTool
  switch (responseFormat.type) {
    case "json_object":
      tool = {
        name: STRUCTURED_OUTPUT_TOOL,
        description: DEFAULT_DESCRIPTION,
        input_schema: { type: "object" },
      }
      break
    case "json_schema":
      tool = jsonSchemaTool((responseFormat as { json_schema?: unknown }).json_schema)
      break
    default:
      rejectField(
        `${FIELD}.type`,
        "names a structured-output type this build cannot carry onto anthropic; it carries `text`, `json_object` and `json_schema`",
      )
  }

  if (clientTools !== undefined && clientTools.length > 0) {
    rejectField(
      "tools",
      `cannot be combined with \`${FIELD}\` on anthropic: the answer's shape is carried by a forced tool call, which leaves no room for the caller's own tools; send one or the other`,
    )
  }
  return { tools: [tool], tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL } }
}

function jsonSchemaTool(spec: unknown): AnthropicTool {
  const at = `${FIELD}.json_schema`
  if (!isPlainObject(spec)) rejectField(at, "must be an object when `type` is `json_schema`")
  const schema = spec.schema
  if (!isPlainObject(schema)) {
    rejectField(
      `${at}.schema`,
      "must be a JSON Schema object: an invented schema would promise a constraint the caller never stated",
    )
  }
  if (schema.type !== undefined && schema.type !== "object") {
    rejectField(
      `${at}.schema`,
      'must have a root of `type: "object"` on anthropic: a tool input is an object, so a root array or scalar cannot be forced',
    )
  }
  const description = spec.description
  if (description !== undefined && description !== null && typeof description !== "string") {
    rejectField(`${at}.description`, "must be a string")
  }
  return {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      typeof description === "string" && description.length > 0 ? description : DEFAULT_DESCRIPTION,
    input_schema: schema.type === undefined ? { ...schema, type: "object" } : schema,
  }
}

/**
 * A client tool named {@link STRUCTURED_OUTPUT_TOOL} would be read back as an answer instead of a
 * call, so the name is reserved. Refused whether or not `response_format` is set: the response
 * half cannot tell the two requests apart.
 */
export function assertNoReservedTool(
  tools: readonly { readonly function?: { readonly name: string } | undefined }[] | undefined,
): void {
  for (const [index, tool] of (tools ?? []).entries()) {
    if (tool.function?.name === STRUCTURED_OUTPUT_TOOL) {
      rejectField(
        `tools[${index}].function.name`,
        `\`${STRUCTURED_OUTPUT_TOOL}\` is reserved: the router names its structured-output tool that on anthropic`,
      )
    }
  }
}

/** Whether the model must call a tool; the dialect forbids that beside extended thinking. */
export function forcesToolUse(choice: AnthropicToolChoice | undefined): boolean {
  return choice?.type === "any" || choice?.type === "tool"
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
