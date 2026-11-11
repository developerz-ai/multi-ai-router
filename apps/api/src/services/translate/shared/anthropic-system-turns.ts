import { type ParsedAnthropicMessage, UNSUPPORTED_BLOCK } from "./anthropic"
import { dropBlock } from "./anthropic-blocks"
import { BLOCK_JOIN } from "./anthropic-turns"
import type { DropSink } from "./drops"
import { isRecord } from "./is-record"

/**
 * Anthropic's `system` as a **mid-conversation role**: per-turn instructions, and — beta —
 * `tool_addition` / `tool_removal` blocks. Each OpenAI translator emits one turn in the same
 * position — `developer` on openai-responses, `system` on openai-chat, whose compatible vendors
 * refuse a mid-list `developer` — and only the *top-level* `system` field becomes the system prompt
 * / `instructions`.
 *
 * The Agent-SDK path reads the same role (`providers/claude-sdk/request.ts`) and renders tool
 * changes with the same words, so one body says the same thing to the model whichever account
 * serves it.
 *
 * Pure. Only text is carried: a tool change is *named* (this router registers tools from `tools`
 * alone, so an addition is news to the model, not a callable tool), and any other block is
 * reported as a drop by type name.
 */

/**
 * Which `system` turns are cleared: `clear_at: "next_user_message"` with a later user turn. The API
 * keeps such a turn in the array but no longer shows it to the model, so the translators skip it.
 * The last user turn is found once, so a transcript with many system turns stays linear.
 */
export function clearedSystemTurns(
  messages: readonly ParsedAnthropicMessage[],
): (index: number) => boolean {
  const lastUser = messages.findLastIndex((message) => message.role === "user")
  return (index) => {
    const message = messages[index]
    return (
      message?.role === "system" && message.clear_at === "next_user_message" && index < lastUser
    )
  }
}

/** The turn's text; empty when nothing in it renders. */
export function systemTurnText(
  message: ParsedAnthropicMessage,
  at: string,
  onDrop: DropSink,
  target: string,
): string {
  if (typeof message.content === "string") return message.content
  const texts: string[] = []
  for (const [index, block] of message.content.entries()) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) texts.push(block.text)
        break
      case "tool_addition":
        texts.push(`[the client added the tool ${toolName(block.tool)}]`)
        break
      case "tool_removal":
        texts.push(`[the client withdrew the tool ${toolName(block.tool)}]`)
        break
      default:
        dropBlock(
          onDrop,
          `${at}.content[${index}]`,
          block.type === UNSUPPORTED_BLOCK ? block.actual : block.type,
          target,
        )
    }
  }
  return texts.join(BLOCK_JOIN)
}

function toolName(tool: unknown): string {
  if (!isRecord(tool)) return "(unnamed)"
  if (typeof tool.name === "string") return tool.name
  if (isRecord(tool.definition) && typeof tool.definition.name === "string") {
    return tool.definition.name
  }
  return typeof tool.server_name === "string" ? `set from ${tool.server_name}` : "(unnamed)"
}
