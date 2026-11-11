import type { AnthropicToolChoice, ParsedAnthropicToolChoice } from "./anthropic"
import { type DropSink, IGNORE_DROPS } from "./drops"
import type { OpenAiChatTool, OpenAiChatToolChoice } from "./openai-chat"
import { forcesToolUse } from "./structured-output-anthropic"
import { toolChoiceToOpenAiChat } from "./tools"

/**
 * The `tool_choice` that survives the tool list it points at.
 *
 * A choice naming a tool `toolsToOpenAiChat` dropped — or any choice at all once no tool is left — would
 * be refused by the upstream as naming an unknown tool, on a body the router wrote. So it goes the
 * way the tool went: dropped and reported, and the model chooses freely among what remains.
 */
export function toolChoiceForOpenAiChat(
  choice: ParsedAnthropicToolChoice | undefined,
  tools: readonly OpenAiChatTool[] | undefined,
  onDrop: DropSink = IGNORE_DROPS,
): OpenAiChatToolChoice | undefined {
  if (choice === undefined) return undefined
  // No `tools` at all is the client's own shape and passes as it always did; an *emptied* list is
  // the router's doing, and the choice it orphaned goes with it.
  if (tools === undefined) return toolChoiceToOpenAiChat(choice)
  if (tools.length === 0) {
    if (choice.type === "auto" || choice.type === "none") return undefined
    onDrop({
      field: "tool_choice",
      reason: "names a tool but no tool survived translation; dropped",
    })
    return undefined
  }
  if (choice.type === "tool" && !tools.some((tool) => tool.function.name === choice.name)) {
    onDrop({
      field: "tool_choice",
      reason: `names \`${choice.name}\`, a tool that was dropped in translation; dropped with it`,
    })
    return undefined
  }
  return toolChoiceToOpenAiChat(choice)
}

/**
 * Whether an openai-chat `tool_choice` obliges the model to call a tool. Accepts `unknown` so it
 * can read a field off an already-translated body object as well as a typed choice; `null` (never
 * emitted, but defensively handled) and the string policies `auto` / `none` force nothing.
 */
export function forcesOpenAiChatTool(choice: OpenAiChatToolChoice | unknown): boolean {
  return choice === "required" || (typeof choice === "object" && choice !== null)
}

export interface AnthropicToolPolicy {
  readonly tool_choice?: AnthropicToolChoice | undefined
  /** Stated last in the body: a forced call and extended thinking cannot share a request. */
  readonly thinking?: { readonly type: "disabled" } | undefined
}

/**
 * The one `tool_choice` + `thinking` rule for every OpenAI dialect aimed at Anthropic, so two
 * ingress dialects with the same intent produce the same body.
 *
 * `parallel_tool_calls` becomes `disable_parallel_tool_use` on `auto` / `any` / `tool` — an absent
 * choice is `auto` — and only when tools are declared. `none` states no parallel policy in
 * Anthropic's dialect, so it travels bare. A choice that forces a call brings
 * `thinking: {type: "disabled"}` with it (`forcesToolUse`): think-by-default Anthropic-dialect
 * vendors otherwise ignore the force and answer in prose.
 */
export function anthropicToolPolicy(
  choice: AnthropicToolChoice | undefined,
  parallel: boolean | null | undefined,
  hasTools: boolean,
): AnthropicToolPolicy {
  const tool_choice =
    parallel === undefined || parallel === null || !hasTools || choice?.type === "none"
      ? choice
      : { ...(choice ?? { type: "auto" as const }), disable_parallel_tool_use: !parallel }
  return forcesToolUse(tool_choice)
    ? { tool_choice, thinking: { type: "disabled" } }
    : { tool_choice }
}
