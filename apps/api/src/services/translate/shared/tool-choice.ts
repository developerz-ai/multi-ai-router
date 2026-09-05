import type { ParsedAnthropicToolChoice } from "./anthropic"
import { type DropSink, IGNORE_DROPS } from "./drops"
import type { OpenAiChatTool, OpenAiChatToolChoice } from "./openai-chat"
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
