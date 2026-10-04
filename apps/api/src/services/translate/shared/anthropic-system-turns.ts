import { type ParsedAnthropicMessage, UNSUPPORTED_BLOCK } from "./anthropic"
import { dropBlock } from "./anthropic-blocks"
import { BLOCK_JOIN } from "./anthropic-turns"
import type { DropSink } from "./drops"

/**
 * Anthropic's `system` as a **mid-conversation role**: per-turn instructions, and — beta —
 * `tool_addition` / `tool_removal` blocks. Both OpenAI dialects state the same thing as a
 * `developer` turn, so each translator emits one in the same position; only the *top-level*
 * `system` field becomes the system prompt / `instructions`.
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
 * A `system` turn with `clear_at: "next_user_message"` that a later user turn has followed. The API
 * keeps it in the array but no longer shows it to the model, so the translators skip it.
 */
export function isClearedSystemTurn(
  messages: readonly ParsedAnthropicMessage[],
  index: number,
): boolean {
  const message = messages[index]
  if (message?.role !== "system" || message.clear_at !== "next_user_message") return false
  return messages.slice(index + 1).some((later) => later.role === "user")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
