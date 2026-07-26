import type { OpenAiChatCeiling } from "@multi-ai-router/core"
import type { ParsedAnthropicBlock, ParsedAnthropicMessage } from "../shared/anthropic"
import { anthropicRequestSchema } from "../shared/anthropic"
import { imageUrlFromSource, systemText, toolResultText } from "../shared/anthropic-blocks"
import type {
  OpenAiChatMessage,
  OpenAiChatPart,
  OpenAiChatRequest,
  OpenAiChatRole,
  OpenAiChatToolCall,
} from "../shared/openai-chat"
import { chatCeiling } from "../shared/openai-chat"
import { parseRequest, rejectField } from "../shared/reject"
import { argumentsFromInput, toolChoiceToOpenAiChat, toolsToOpenAiChat } from "../shared/tools"

/**
 * `POST /v1/messages` body → a Chat Completions body. Pure: no clock, no store, no network, no
 * logger (docs/idea/06-protocol-translation.md#design-rules).
 *
 * The three structural moves, all of which change message *count*:
 *
 * 1. `system` — a string or a text-block array — becomes one leading `role:"system"` message.
 * 2. Each `tool_result` block leaves its user turn as its own `role:"tool"` message, emitted at the
 *    position it was found so it lands directly after the assistant turn that called it.
 * 3. Text and `tool_use` blocks of one assistant turn collapse into one message carrying both
 *    `content` and `tool_calls`.
 *
 * Dropped, as documented: `top_k`, `cache_control`, `thinking` / `redacted_thinking` blocks,
 * `metadata`, and any `anthropic-beta` opt-in (a header, handled by the transport). Refused:
 * server-side tools, `document` blocks, and anything else with no target representation — a
 * contract field is never dropped quietly.
 *
 * Anthropic **requires** `max_tokens`, so every request through here carries a ceiling the caller
 * chose, and which of openai-chat's two names it is emitted under is the target's answer, not
 * ours — see {@link chatCeiling}.
 */

/** What a refusal calls the thing an Anthropic `tool_result` lands in on this side. */
const TOOL_CARRIER = 'an openai-chat `role:"tool"` message'

export interface AnthropicToOpenAiChatOptions {
  /** Which spelling of the output ceiling the selected Account accepts. Defaults to `max_tokens`. */
  readonly ceiling?: OpenAiChatCeiling | undefined
}

interface Draft {
  readonly role: OpenAiChatRole
  readonly parts: OpenAiChatPart[]
  readonly toolCalls: OpenAiChatToolCall[]
  readonly toolCallId?: string
}

/** @throws TranslationError (400) naming the field that has no openai-chat representation. */
export function anthropicToOpenAiChatRequest(
  body: unknown,
  options: AnthropicToOpenAiChatOptions = {},
): OpenAiChatRequest {
  const request = parseRequest(anthropicRequestSchema, body, "anthropic")
  const drafts: Draft[] = []

  const system = systemText(request.system)
  if (system.length > 0) {
    drafts.push({ role: "system", parts: [{ type: "text", text: system }], toolCalls: [] })
  }

  for (const [index, message] of request.messages.entries()) {
    appendMessage(drafts, message, `messages[${index}]`)
  }

  // `undefined` members are dropped by `JSON.stringify` on the way out, so an absent field stays
  // absent rather than becoming an explicit null the upstream has to interpret.
  return {
    model: request.model,
    messages: merge(drafts).map(finalize),
    ...chatCeiling(request.max_tokens, options.ceiling),
    temperature: request.temperature,
    top_p: request.top_p,
    stop: request.stop_sequences,
    stream: request.stream,
    // Without this an OpenAI stream reports no usage at all, and the terminal `message_delta` we
    // synthesize back toward an Anthropic client would have to carry null tokens every time.
    stream_options: request.stream === true ? { include_usage: true } : undefined,
    tools: request.tools === undefined ? undefined : toolsToOpenAiChat(request.tools),
    tool_choice:
      request.tool_choice === undefined ? undefined : toolChoiceToOpenAiChat(request.tool_choice),
  }
}

function appendMessage(drafts: Draft[], message: ParsedAnthropicMessage, at: string): void {
  const blocks: readonly ParsedAnthropicBlock[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content

  const parts: OpenAiChatPart[] = []
  const toolCalls: OpenAiChatToolCall[] = []

  for (const [index, block] of blocks.entries()) {
    const field = `${at}.content[${index}]`
    switch (block.type) {
      case "text":
        if (block.text.length > 0) parts.push({ type: "text", text: block.text })
        break
      case "image":
        parts.push({ type: "image_url", image_url: { url: imageUrlFromSource(block.source) } })
        break
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: argumentsFromInput(block.input) },
        })
        break
      case "tool_result":
        drafts.push({
          role: "tool",
          toolCallId: block.tool_use_id,
          parts: [{ type: "text", text: toolResultText(block, field, TOOL_CARRIER) }],
          toolCalls: [],
        })
        break
      case "thinking":
      case "redacted_thinking":
        // Documented drop. Re-sending a reasoning block as plain text would put the model's own
        // scratchpad into the transcript as if a participant had said it.
        break
      default:
        rejectField(`${field}.type`, `\`${block.actual}\` has no openai-chat counterpart`)
    }
  }

  if (message.role === "user" && toolCalls.length > 0) {
    rejectField(
      `${at}.content`,
      "carries a `tool_use` block on a user turn, which openai-chat cannot express",
    )
  }
  if (parts.length === 0 && toolCalls.length === 0) return
  drafts.push({ role: message.role, parts, toolCalls })
}

/**
 * Consecutive same-role turns fold into one.
 *
 * openai-chat does not require alternation, so this is not a correctness fix for the target — it is
 * one for the *upstreams*: several OpenAI-compatible providers reject two adjacent `user` messages
 * that OpenAI itself accepts. Only plain-content turns merge. A turn carrying `tool_calls` or a
 * `tool_call_id` is keyed to one specific call, and folding it would break that pairing.
 */
function merge(drafts: readonly Draft[]): Draft[] {
  const merged: Draft[] = []
  for (const draft of drafts) {
    const previous = merged.at(-1)
    if (previous !== undefined && mergeable(previous, draft)) {
      previous.parts.push(...draft.parts)
      continue
    }
    merged.push(draft)
  }
  return merged
}

function mergeable(previous: Draft, next: Draft): boolean {
  if (previous.role !== next.role) return false
  if (previous.toolCallId !== undefined || next.toolCallId !== undefined) return false
  return previous.toolCalls.length === 0 && next.toolCalls.length === 0
}

function finalize(draft: Draft): OpenAiChatMessage {
  return {
    role: draft.role,
    content: collapse(draft.parts),
    tool_calls: draft.toolCalls.length === 0 ? undefined : draft.toolCalls,
    tool_call_id: draft.toolCallId,
  }
}

/** A lone text part is emitted as a plain string — the shape every compatible upstream accepts. */
function collapse(
  parts: readonly OpenAiChatPart[],
): string | readonly OpenAiChatPart[] | undefined {
  if (parts.length === 0) return undefined
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.type === "text") return only.text
  return parts
}
