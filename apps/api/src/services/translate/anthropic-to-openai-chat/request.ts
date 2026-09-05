import type { OpenAiChatCeiling } from "@multi-ai-router/core"
import type { ParsedAnthropicBlock, ParsedAnthropicMessage } from "../shared/anthropic"
import { anthropicRequestSchema } from "../shared/anthropic"
import {
  documentText,
  dropBlock,
  imageUrlFromSource,
  systemText,
  toolResultParts,
} from "../shared/anthropic-blocks"
import { type DropSink, IGNORE_DROPS } from "../shared/drops"
import type {
  OpenAiChatMessage,
  OpenAiChatPart,
  OpenAiChatRequest,
  OpenAiChatRole,
  OpenAiChatToolCall,
} from "../shared/openai-chat"
import { chatCeiling } from "../shared/openai-chat"
import { parseRequest, rejectField } from "../shared/reject"
import { toolChoiceForOpenAiChat } from "../shared/tool-choice"
import { argumentsFromInput, toolsToOpenAiChat } from "../shared/tools"

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
 * Dropped silently, as documented: `top_k`, `cache_control`, `thinking` / `redacted_thinking`
 * blocks, `metadata`, the `thinking` / `output_config` / `context_management` request knobs, and any
 * `anthropic-beta` opt-in (a header, handled by the transport). Dropped and **reported** through
 * `options.onDrop`: server-side and built-in tools, a `tool_choice` naming one, non-text documents,
 * and any block type the target cannot carry. An image inside a `tool_result` is hoisted into a
 * user turn directly after the tool message. Refused: only what is not a valid Anthropic request.
 *
 * Anthropic **requires** `max_tokens`, so every request through here carries a ceiling the caller
 * chose, and which of openai-chat's two names it is emitted under is the target's answer, not
 * ours — see {@link chatCeiling}.
 */

/** What a drop report calls the thing an Anthropic block would have landed in on this side. */
const TARGET = "an openai-chat message"

export interface AnthropicToOpenAiChatOptions {
  /** Which spelling of the output ceiling the selected Account accepts. Defaults to `max_tokens`. */
  readonly ceiling?: OpenAiChatCeiling | undefined
  /** Where a dropped field is reported. Absent, drops are silent (`shared/drops.ts`). */
  readonly onDrop?: DropSink | undefined
}

interface Draft {
  readonly role: OpenAiChatRole
  readonly parts: OpenAiChatPart[]
  readonly toolCalls: OpenAiChatToolCall[]
  readonly toolCallId?: string
}

/** @throws TranslationError (400) when the body is not a valid Anthropic request. */
export function anthropicToOpenAiChatRequest(
  body: unknown,
  options: AnthropicToOpenAiChatOptions = {},
): OpenAiChatRequest {
  const request = parseRequest(anthropicRequestSchema, body, "anthropic")
  const onDrop = options.onDrop ?? IGNORE_DROPS
  const drafts: Draft[] = []

  const system = systemText(request.system)
  if (system.length > 0) {
    drafts.push({ role: "system", parts: [{ type: "text", text: system }], toolCalls: [] })
  }

  for (const [index, message] of request.messages.entries()) {
    appendMessage(drafts, message, `messages[${index}]`, onDrop)
  }

  const tools = request.tools === undefined ? undefined : toolsToOpenAiChat(request.tools, onDrop)

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
    // An empty list is not "no tools" to every compatible upstream — several refuse `tools: []`
    // outright — so a toolkit that translated to nothing is omitted rather than sent empty.
    tools: tools === undefined || tools.length === 0 ? undefined : tools,
    tool_choice: toolChoiceForOpenAiChat(request.tool_choice, tools, onDrop),
  }
}

function appendMessage(
  drafts: Draft[],
  message: ParsedAnthropicMessage,
  at: string,
  onDrop: DropSink,
): void {
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
      case "tool_result": {
        const result = toolResultParts(block, field, onDrop)
        drafts.push({
          role: "tool",
          toolCallId: block.tool_use_id,
          parts: [{ type: "text", text: result.text }],
          toolCalls: [],
        })
        // Hoisted: a `role:"tool"` message holds text only, so the image lands in a user turn right
        // after it — the position a person pasting the screenshot would give it. Plain content, so
        // `merge` folds it into the rest of this user turn.
        if (result.images.length > 0) {
          drafts.push({
            role: "user",
            parts: result.images.map((source) => ({
              type: "image_url",
              image_url: { url: imageUrlFromSource(source) },
            })),
            toolCalls: [],
          })
        }
        break
      }
      case "document": {
        const text = documentText(block, field, onDrop)
        if (text !== null && text.length > 0) parts.push({ type: "text", text })
        break
      }
      case "thinking":
      case "redacted_thinking":
        // Documented drop. Re-sending a reasoning block as plain text would put the model's own
        // scratchpad into the transcript as if a participant had said it.
        break
      default:
        // `server_tool_use`, `web_search_tool_result`, and whatever Anthropic ships next: the
        // provider's own artifacts, whose visible outcome is already in the text blocks beside them.
        dropBlock(onDrop, field, block.actual, TARGET)
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
