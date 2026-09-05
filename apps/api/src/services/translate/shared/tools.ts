import { z } from "zod"
import type {
  AnthropicTool,
  AnthropicToolChoice,
  ParsedAnthropicTool,
  ParsedAnthropicToolChoice,
} from "./anthropic"
import { type DropSink, IGNORE_DROPS } from "./drops"
import type { OpenAiChatTool, OpenAiChatToolChoice } from "./openai-chat"
import type {
  OpenAiResponsesTool,
  OpenAiResponsesToolChoice,
  ParsedOpenAiResponsesTool,
  ParsedOpenAiResponsesToolChoice,
} from "./openai-responses"
import { rejectField } from "./reject"

/**
 * Tool declarations, tool choice, and the call payload, across every dialect seam.
 *
 * The declarations are near-identical — `{name, description, input_schema}` against
 * `function.{name, description, parameters}` against a **flat** Responses
 * `{type:"function", name, parameters}` — so almost all of the work here is the one shape
 * difference that is *not* cosmetic: Anthropic's `tool_use.input` is a **JSON object** and OpenAI's
 * `tool_calls[].function.arguments` is a **JSON string**. Every crossing parses or serializes, and
 * a string that does not decode to an object is a `400`, never an empty call handed to a model
 * that will act on it (docs/idea/06-protocol-translation.md#tool-and-function-calling).
 *
 * **openai-responses converts through the openai-chat shape**, in both directions and by design: the
 * two differ only by one level of nesting, and giving Responses its own path to Anthropic would be a
 * second copy of the JSON-Schema validation that could disagree with the first.
 *
 * Ids are preserved verbatim in every direction; a translator that mints its own breaks the
 * `tool_use` ↔ `tool_result` pairing on the next turn.
 */

/**
 * The structural minimum of an openai-chat tool.
 *
 * Both a parsed body and a tool this module just built are accepted, because the Responses
 * conversions hand their output straight on to the Anthropic ones.
 */
interface ChatToolLike {
  readonly type?: string | undefined
  readonly function?:
    | {
        readonly name: string
        readonly description?: string | undefined
        readonly parameters?: Record<string, unknown> | undefined
      }
    | undefined
}

/** The same minimum for a tool choice — a bare mode, or a named function however it is nested. */
type ChatToolChoiceLike =
  | "none"
  | "auto"
  | "required"
  | { readonly type?: string | undefined; readonly function: { readonly name: string } }

const jsonObject = z.record(z.string(), z.unknown())

const NOT_JSON = "is not valid JSON: an anthropic `tool_use.input` is an object, not a blob"
const NOT_AN_OBJECT =
  "must decode to a JSON object: an anthropic `tool_use.input` has no array or scalar form"

/** Anthropic mandates an object schema. A tool taking no arguments still declares one. */
function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {} }
}

function assertObjectSchema(schema: Record<string, unknown>, field: string): void {
  const type = schema.type
  if (type !== undefined && type !== "object") {
    rejectField(field, 'must be a JSON Schema of `type: "object"`')
  }
}

/**
 * Anthropic tool declarations → openai-chat function tools.
 *
 * A declaration with no `input_schema` is an Anthropic **server-side or built-in** tool — web search,
 * code execution, the tool-search tool, `bash_20250124`, `text_editor_20250728`: a capability of
 * Anthropic's own inference or a tool whose schema Anthropic supplies, not a declaration another
 * upstream can act on. It is dropped and reported by name, never refused: Claude Code sends its
 * whole toolkit on every turn, and a `400` over one tool the client never asked *this* upstream to
 * run served nothing at all. The deferred-loading marker (`defer_loading`), `strict`,
 * `eager_input_streaming` and `cache_control` are stripped by the schema — a target with no tool
 * search gets every tool up front, which is the faithful reading of "deferred".
 *
 * @throws TranslationError (400) for a declaration that is not a valid Anthropic tool at all — no
 * name, or a schema that is not an object schema.
 */
export function toolsToOpenAiChat(
  tools: readonly ParsedAnthropicTool[],
  onDrop: DropSink = IGNORE_DROPS,
): OpenAiChatTool[] {
  const out: OpenAiChatTool[] = []
  for (const [index, tool] of tools.entries()) {
    const at = `tools[${index}]`
    const name = tool.name
    if (name === undefined || name.length === 0) rejectField(`${at}.name`, "is required")

    const schema = tool.input_schema
    if (schema === undefined) {
      onDrop({
        field: at,
        reason: `\`${name}\` is an Anthropic server-side or built-in tool (type \`${tool.type ?? "unknown"}\`) with no openai-chat counterpart; dropped`,
      })
      continue
    }
    assertObjectSchema(schema, `${at}.input_schema`)

    out.push({
      type: "function",
      function: { name, description: tool.description, parameters: schema },
    })
  }
  return out
}

export function toolsToAnthropic(tools: readonly ChatToolLike[]): AnthropicTool[] {
  return tools.map((tool, index) => {
    const at = `tools[${index}]`
    const fn = tool.function
    if (fn === undefined) {
      rejectField(
        at,
        `declares no \`function\`: tool type \`${tool.type ?? "unknown"}\` has no anthropic counterpart`,
      )
    }

    const parameters = fn.parameters
    if (parameters === undefined) {
      return { name: fn.name, description: fn.description, input_schema: emptyObjectSchema() }
    }
    assertObjectSchema(parameters, `${at}.function.parameters`)

    return {
      name: fn.name,
      description: fn.description,
      // OpenAI lets `type` stay implicit on an object schema; Anthropic requires it stated.
      input_schema: parameters.type === undefined ? { ...parameters, type: "object" } : parameters,
    }
  })
}

export function toolChoiceToOpenAiChat(choice: ParsedAnthropicToolChoice): OpenAiChatToolChoice {
  switch (choice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      return { type: "function", function: { name: choice.name } }
  }
}

export function toolChoiceToAnthropic(choice: ChatToolChoiceLike): AnthropicToolChoice {
  if (choice === "auto") return { type: "auto" }
  if (choice === "required") return { type: "any" }
  if (choice === "none") return { type: "none" }
  return { type: "tool", name: choice.function.name }
}

/**
 * A flat Responses tool → the nested openai-chat shape every other conversion here reads.
 *
 * A built-in (`web_search_preview`, `file_search`, `code_interpreter`, …) is a capability of
 * OpenAI's own inference rather than a function the client can execute, so nothing on the other side
 * of any seam runs it — the same call `toolsToOpenAiChat` makes about an Anthropic server tool.
 *
 * @throws TranslationError (400) naming the tool that has no counterpart.
 */
export function toolsFromOpenAiResponses(
  tools: readonly ParsedOpenAiResponsesTool[],
): OpenAiChatTool[] {
  return tools.map((tool, index) => {
    const at = `tools[${index}]`
    const type = tool.type ?? "function"
    const name = tool.name
    if (type !== "function" || name === undefined || name.length === 0) {
      rejectField(
        at,
        `declares tool type \`${type}\`, a built-in served inside openai-responses, which has no counterpart on another dialect`,
      )
    }

    const parameters = tool.parameters
    if (parameters !== undefined) assertObjectSchema(parameters, `${at}.parameters`)
    return {
      type: "function",
      function: { name, description: tool.description, parameters: parameters ?? {} },
    }
  })
}

/**
 * The nested openai-chat shape → a flat Responses tool.
 *
 * @throws TranslationError (400) naming a tool that declares no `function` at all — an openai-chat
 * built-in, which nothing outside openai-chat runs.
 */
export function toolsToOpenAiResponses(tools: readonly ChatToolLike[]): OpenAiResponsesTool[] {
  return tools.map((tool, index) => {
    const at = `tools[${index}]`
    const fn = tool.function
    if (fn === undefined) {
      rejectField(
        at,
        `declares no \`function\`: tool type \`${tool.type ?? "unknown"}\` has no openai-responses counterpart`,
      )
    }

    const parameters = fn.parameters
    if (parameters !== undefined) assertObjectSchema(parameters, `${at}.function.parameters`)
    return {
      type: "function",
      name: fn.name,
      description: fn.description,
      parameters: parameters === undefined ? emptyObjectSchema() : parameters,
    }
  })
}

export function toolChoiceFromOpenAiResponses(
  choice: ParsedOpenAiResponsesToolChoice,
): OpenAiChatToolChoice {
  if (typeof choice === "string") return choice
  const name = choice.name
  if (choice.type !== "function" || name === undefined) {
    rejectField(
      "tool_choice.type",
      `\`${choice.type}\` names a built-in served inside openai-responses, which has no counterpart on another dialect`,
    )
  }
  return { type: "function", function: { name } }
}

export function toolChoiceToOpenAiResponses(choice: ChatToolChoiceLike): OpenAiResponsesToolChoice {
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

/** Object → JSON string. The direction that cannot fail. */
export function argumentsFromInput(input: Record<string, unknown>): string {
  return JSON.stringify(input)
}

/**
 * JSON string → object, or a `400` naming the call whose arguments did not decode.
 *
 * An absent or blank string is a no-argument call, which is how the OpenAI SDK and several
 * compatible upstreams spell it — that one is `{}`, not a failure.
 */
export function inputFromArguments(
  raw: string | undefined,
  field: string,
): Record<string, unknown> {
  if (raw === undefined || raw.trim().length === 0) return {}

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    rejectField(field, NOT_JSON)
  }

  if (Array.isArray(decoded)) rejectField(field, NOT_AN_OBJECT)
  const parsed = jsonObject.safeParse(decoded)
  if (!parsed.success) rejectField(field, NOT_AN_OBJECT)
  return parsed.data
}
