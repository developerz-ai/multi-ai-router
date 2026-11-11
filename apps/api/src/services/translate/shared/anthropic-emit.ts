import type { ParsedAnthropicImageSource, ParsedAnthropicToolChoice } from "./anthropic"
import type { CacheControl } from "./cache-control-schema"

/**
 * The Anthropic Messages body the `* → anthropic` request translators and the `* → anthropic`
 * response translators **emit**: plain readonly shapes, never parsed. The parsed reading of a
 * client's Anthropic body is `anthropic.ts`.
 */

export interface AnthropicTextBlock {
  readonly type: "text"
  readonly text: string
  readonly cache_control?: CacheControl | undefined
}

export interface AnthropicImageBlock {
  readonly type: "image"
  readonly source: ParsedAnthropicImageSource
  readonly cache_control?: CacheControl | undefined
}

export interface AnthropicToolUseBlock {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/** Native tool results carry text or text/image blocks; Chat hoists images separately. */
export interface AnthropicToolResultBlock {
  readonly type: "tool_result"
  readonly tool_use_id: string
  readonly content: string | readonly (AnthropicTextBlock | AnthropicImageBlock)[]
  readonly cache_control?: CacheControl | undefined
}

/**
 * A `thinking` block this router synthesized from another dialect's reasoning summary. Its
 * `signature` is the router's tag (`router-thinking.ts`), never one Anthropic minted.
 */
export interface AnthropicThinkingBlock {
  readonly type: "thinking"
  readonly thinking: string
  readonly signature: string
}

/** A reasoning item with no summary, carried as its sealed blob (`sealed-reasoning.ts`). */
export interface AnthropicRedactedThinkingBlock {
  readonly type: "redacted_thinking"
  readonly data: string
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  readonly role: "user" | "assistant"
  readonly content: readonly AnthropicBlock[]
}

export interface AnthropicTool {
  readonly name: string
  readonly description?: string | undefined
  readonly input_schema: Record<string, unknown>
}

export type AnthropicToolChoice = ParsedAnthropicToolChoice

export interface AnthropicRequest {
  readonly model: string
  readonly messages: readonly AnthropicMessage[]
  readonly max_tokens: number
  /** An array only when a block carries a cache breakpoint; otherwise the joined string. */
  readonly system?: string | readonly AnthropicTextBlock[] | undefined
  readonly temperature?: number | undefined
  readonly top_p?: number | undefined
  readonly stop_sequences?: readonly string[] | undefined
  readonly stream?: boolean | undefined
  readonly tools?: readonly AnthropicTool[] | undefined
  readonly tool_choice?: AnthropicToolChoice | undefined
  readonly output_config?: { readonly effort: string } | undefined
  readonly thinking?: { readonly type: "disabled" } | undefined
  /** Automatic caching: the client's own top-level marker, or the router's toward Anthropic. */
  readonly cache_control?: CacheControl | undefined
}
