import { type DropSink, IGNORE_DROPS } from "./drops"
import type { OpenAiChatTool, OpenAiChatToolChoice } from "./openai-chat"
import type { ParsedOpenAiResponsesTool, ParsedOpenAiResponsesToolChoice } from "./openai-responses"
import { rejectField } from "./reject"
import { assertObjectSchema } from "./tools"

/**
 * Responses tool declarations and `tool_choice` → the nested openai-chat shape every other
 * conversion here reads.
 *
 * A tool OpenAI **hosts** (`web_search*`, `file_search`, `code_interpreter`, `image_generation`,
 * `mcp`) runs inside OpenAI's own inference, so nothing on another dialect runs it and nothing on the
 * client was going to: it is dropped and reported by name, the same call `toolsToOpenAiChat` makes
 * about an Anthropic server tool, so a client that ships its whole toolkit every turn is still
 * served. A choice that forced a dropped tool goes with it.
 *
 * Any other non-`function` type is **client-executed** — a `custom` free-form tool (Codex's
 * `apply_patch`), `local_shell`, `computer_use_preview`, or a type this build has never seen — and
 * is refused by name: the client will act on its calls, and there is no JSON-schema declaration to
 * carry it as, so dropping it would quietly take a capability away from the agent.
 */

/** Tool types OpenAI executes server-side. `web_search` is a prefix: it carries dated variants. */
const HOSTED = new Set(["file_search", "code_interpreter", "image_generation", "mcp"])

function isHosted(type: string): boolean {
  return type.startsWith("web_search") || HOSTED.has(type)
}

/** @throws TranslationError (400) naming a client-executed tool that has no counterpart. */
export function toolsFromOpenAiResponses(
  tools: readonly ParsedOpenAiResponsesTool[],
  onDrop: DropSink = IGNORE_DROPS,
): OpenAiChatTool[] {
  const out: OpenAiChatTool[] = []
  for (const [index, tool] of tools.entries()) {
    const at = `tools[${index}]`
    const type = tool.type ?? "function"
    if (type !== "function" && isHosted(type)) {
      onDrop({
        field: at,
        reason: `tool type \`${type}\` is a built-in OpenAI hosts inside openai-responses, with no counterpart on another dialect; dropped`,
      })
      continue
    }
    const name = tool.name
    if (type !== "function") {
      rejectField(
        at,
        `declares tool type \`${type}\`, a client-executed tool with no JSON-schema function form on another dialect`,
      )
    }
    if (name === undefined || name.length === 0) rejectField(`${at}.name`, "is required")

    const parameters = tool.parameters
    if (parameters !== undefined) assertObjectSchema(parameters, `${at}.parameters`)
    out.push({
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters: parameters ?? {},
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    })
  }
  return out
}

/**
 * A Responses `tool_choice` → openai-chat's, against the tools that survived
 * {@link toolsFromOpenAiResponses}. A choice forcing a dropped hosted tool, or `required` once every
 * declared tool was dropped, is dropped and reported; `auto` / `none` over an emptied list go
 * silently, since they force nothing.
 *
 * @throws TranslationError (400) for a choice naming a client-executed built-in.
 */
export function toolChoiceFromOpenAiResponses(
  choice: ParsedOpenAiResponsesToolChoice,
  tools: readonly OpenAiChatTool[] | undefined,
  declared: number,
  onDrop: DropSink = IGNORE_DROPS,
): OpenAiChatToolChoice | undefined {
  const emptied = declared > 0 && (tools === undefined || tools.length === 0)
  if (typeof choice === "string") {
    if (!emptied) return choice
    if (choice === "required") {
      onDrop({
        field: "tool_choice",
        reason: "forces a tool but no tool survived translation; dropped",
      })
    }
    return undefined
  }
  if (choice.type === "function") {
    if (choice.name === undefined) rejectField("tool_choice.name", "is required")
    return { type: "function", function: { name: choice.name } }
  }
  if (isHosted(choice.type)) {
    onDrop({
      field: "tool_choice",
      reason: `forces \`${choice.type}\`, a built-in dropped in translation; dropped with it`,
    })
    return undefined
  }
  rejectField(
    "tool_choice.type",
    `\`${choice.type}\` names a client-executed built-in with no counterpart on another dialect`,
  )
}

/**
 * A Responses request's `tools` + `tool_choice` read together, so a choice is judged against the
 * tools that survived. `tools` is absent when the request declared none or every declared tool was
 * a dropped hosted built-in: an empty list the router made is not the client's shape.
 */
export function responsesToolsAsChat(
  tools: readonly ParsedOpenAiResponsesTool[] | undefined,
  choice: ParsedOpenAiResponsesToolChoice | undefined,
  onDrop: DropSink,
): { readonly tools?: OpenAiChatTool[]; readonly tool_choice?: OpenAiChatToolChoice } {
  const kept = tools === undefined ? undefined : toolsFromOpenAiResponses(tools, onDrop)
  const declared = tools?.length ?? 0
  const emitted = kept !== undefined && kept.length === 0 && declared > 0 ? undefined : kept
  const tool_choice =
    choice === undefined ? undefined : toolChoiceFromOpenAiResponses(choice, kept, declared, onDrop)
  return {
    ...(emitted === undefined ? {} : { tools: emitted }),
    ...(tool_choice === undefined ? {} : { tool_choice }),
  }
}
