import type {
  ParsedAnthropicCacheControl,
  ParsedAnthropicRequest,
  ParsedAnthropicToolResult,
} from "./anthropic"
import { BILLING_HEADER_PREFIX } from "./anthropic-blocks"
import { lastMarker, marked } from "./cache-control-schema"
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
const CARRY_MARK: CacheMark = marked

/** The strip every other target gets — a strict upstream `400`s on a field it does not know. */
export function cacheMark(carry: boolean | undefined): CacheMark {
  return carry === true ? CARRY_MARK : NO_MARK
}

/** The tool_result's own marker, else the last one inside it: the result is one part on this side. */
export function toolResultCacheControl(
  block: ParsedAnthropicToolResult,
): ParsedAnthropicCacheControl {
  return block.cache_control ?? lastMarker(block.content)
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
    .filter((block) => block.text.length > 0 && !block.text.startsWith(BILLING_HEADER_PREFIX))
    .map((block) => ({ type: "text" as const, text: block.text, ...mark(block.cache_control) }))
  return parts.some((part) => part.cache_control !== undefined) ? parts : null
}
