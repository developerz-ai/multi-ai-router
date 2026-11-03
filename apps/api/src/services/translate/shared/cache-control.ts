import type {
  ParsedAnthropicCacheControl,
  ParsedAnthropicRequest,
  ParsedAnthropicToolResult,
} from "./anthropic"
import type { OpenAiChatCacheControl, OpenAiChatTextPart } from "./openai-chat"

/**
 * Anthropic prompt-cache breakpoints carried onto openai-chat content parts — for a target that
 * states it reads them (`ProviderSurface.cacheControl`: OpenRouter, which maps the marker to each
 * provider's own). Pure.
 *
 * A breakpoint is a *position*: the cached prefix ends at the block it marks. So a marker is carried
 * on the part that block became and nowhere else, and a marked system prompt keeps one part per
 * block rather than being joined — a marker moved to the end of a joined prompt would cache a
 * prefix that includes the blocks the client deliberately left after it, and miss every turn.
 */

/** Spread into an emitted part: the marker, or nothing. */
export type CacheMark = (control: ParsedAnthropicCacheControl) => {
  readonly cache_control?: OpenAiChatCacheControl
}

const NO_MARK: CacheMark = () => ({})
const CARRY_MARK: CacheMark = (control) => (control === undefined ? {} : { cache_control: control })

/** The strip every other target gets — a strict upstream `400`s on a field it does not know. */
export function cacheMark(carry: boolean | undefined): CacheMark {
  return carry === true ? CARRY_MARK : NO_MARK
}

/** The tool_result's own marker, else the last one inside it: the result is one part on this side. */
export function toolResultCacheControl(
  block: ParsedAnthropicToolResult,
): ParsedAnthropicCacheControl {
  if (block.cache_control !== undefined || typeof block.content !== "object") {
    return block.cache_control
  }
  for (const nested of block.content.toReversed()) {
    const control = "cache_control" in nested ? nested.cache_control : undefined
    if (control !== undefined) return control
  }
  return undefined
}

/**
 * The system prompt as one part per non-empty block, when the target carries markers and at least
 * one block states one; null otherwise, and the caller joins it into one string as before.
 */
export function markedSystemParts(
  system: ParsedAnthropicRequest["system"],
  mark: CacheMark,
): OpenAiChatTextPart[] | null {
  if (!Array.isArray(system)) return null
  const parts = system
    .filter((block) => block.text.length > 0)
    .map((block) => ({ type: "text" as const, text: block.text, ...mark(block.cache_control) }))
  return parts.some((part) => part.cache_control !== undefined) ? parts : null
}
