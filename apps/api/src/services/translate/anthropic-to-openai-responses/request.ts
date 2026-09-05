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
  OpenAiResponsesItem,
  OpenAiResponsesPart,
  OpenAiResponsesRequest,
} from "../shared/openai-responses"
import { assertNoStopSequence, parseRequest, rejectField } from "../shared/reject"
import { toolChoiceForOpenAiChat } from "../shared/tool-choice"
import {
  argumentsFromInput,
  toolChoiceToOpenAiResponses,
  toolsToOpenAiChat,
  toolsToOpenAiResponses,
} from "../shared/tools"

/**
 * `POST /v1/messages` body → an OpenAI Responses body. Pure: no clock, no store, no network, no
 * logger (docs/idea/06-protocol-translation.md#design-rules).
 *
 * Responses takes a **flat list of items** rather than a transcript of messages, which is the whole
 * structural difference from the openai-chat sibling:
 *
 * 1. `system` leaves the list entirely and becomes `instructions`.
 * 2. A turn becomes one `message` item, with `tool_use` and `tool_result` blocks carved out of it
 *    as `function_call` / `function_call_output` items **at the position they were found**. A turn
 *    interleaving text with calls therefore yields more than one message item, which is the cheaper
 *    loss: the alternative reorders the model's own output relative to the calls it made.
 * 3. **Nothing merges across turns.** The openai-chat sibling folds consecutive same-role messages
 *    together only because several chat-compatible upstreams reject two adjacent `user` messages
 *    that OpenAI itself accepts — a claim about those upstreams, not about a dialect. Responses has
 *    no alternation requirement at all and each Anthropic turn is already one item, so folding here
 *    would be a transformation with nothing asking for it.
 *
 * Dropped silently, as documented: `top_k`, `cache_control`, `thinking` / `redacted_thinking`
 * blocks, `metadata`, and any `anthropic-beta` opt-in (a header, handled by the transport). Dropped
 * and **reported** through `options.onDrop`: server-side and built-in tools, a `tool_choice` naming
 * one, non-text documents, and any block type the target cannot carry; an image inside a
 * `tool_result` is hoisted into a user message item after the `function_call_output`. Refused: a
 * stated `stop_sequences` (the dialect has no stop parameter), an image on an assistant turn, and
 * anything that is not a valid Anthropic request.
 */

/** What a drop report calls the thing an Anthropic block would have landed in on this side. */
const TARGET = "an openai-responses item"

export interface AnthropicToOpenAiResponsesOptions {
  /** Where a dropped field is reported. Absent, drops are silent (`shared/drops.ts`). */
  readonly onDrop?: DropSink | undefined
}

const USER_TOOL_USE =
  "carries a `tool_use` block on a user turn, which openai-responses cannot express"

const ASSISTANT_IMAGE =
  "is an `image` block on an assistant turn, which openai-responses cannot express: assistant content holds `output_text` and `refusal` only"

/** @throws TranslationError (400) naming the field that has no openai-responses representation. */
export function anthropicToOpenAiResponsesRequest(
  body: unknown,
  options: AnthropicToOpenAiResponsesOptions = {},
): OpenAiResponsesRequest {
  const request = parseRequest(anthropicRequestSchema, body, "anthropic")
  const onDrop = options.onDrop ?? IGNORE_DROPS

  // openai-responses states no stop parameter at all, and `shared/reject.ts` owns that rule for both
  // dialects that spell it — the same field under two names cannot be servable from one and not the
  // other.
  assertNoStopSequence(request.stop_sequences, "stop_sequences")

  const input: OpenAiResponsesItem[] = []
  for (const [index, message] of request.messages.entries()) {
    appendMessage(input, message, `messages[${index}]`, onDrop)
  }

  const instructions = systemText(request.system)
  // Through the openai-chat shape deliberately: the two differ by one level of nesting, and a
  // second path would be a second copy of the JSON-Schema validation that could disagree with it.
  const chatTools =
    request.tools === undefined ? undefined : toolsToOpenAiChat(request.tools, onDrop)
  const toolChoice = toolChoiceForOpenAiChat(request.tool_choice, chatTools, onDrop)

  // `undefined` members are dropped by `JSON.stringify` on the way out, so an absent field stays
  // absent rather than becoming an explicit null the upstream has to interpret.
  return {
    model: request.model,
    input,
    instructions: instructions.length === 0 ? undefined : instructions,
    max_output_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stream: request.stream,
    tools:
      chatTools === undefined || chatTools.length === 0
        ? undefined
        : toolsToOpenAiResponses(chatTools),
    tool_choice: toolChoice === undefined ? undefined : toolChoiceToOpenAiResponses(toolChoice),
    // The router holds no conversation state and an Anthropic client has no way to name a stored
    // response on its next turn, so one left behind is litter nobody can reference or delete.
    store: false,
  }
}

function appendMessage(
  items: OpenAiResponsesItem[],
  message: ParsedAnthropicMessage,
  at: string,
  onDrop: DropSink,
): void {
  const blocks: readonly ParsedAnthropicBlock[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content

  const role = message.role
  // `input_text` on a user turn, `output_text` on an assistant one — Responses spells them apart,
  // and a part named for the wrong direction is rejected by the upstream rather than reinterpreted.
  const textType = role === "assistant" ? "output_text" : "input_text"
  let parts: OpenAiResponsesPart[] = []

  /** Closes the message item under construction so the next tool item follows it in order. */
  function flush(): void {
    if (parts.length === 0) return
    items.push({ type: "message", role, content: parts })
    parts = []
  }

  for (const [index, block] of blocks.entries()) {
    const field = `${at}.content[${index}]`
    switch (block.type) {
      case "text":
        if (block.text.length > 0) parts.push({ type: textType, text: block.text })
        break
      case "image":
        if (role === "assistant") rejectField(field, ASSISTANT_IMAGE)
        parts.push({ type: "input_image", image_url: imageUrlFromSource(block.source) })
        break
      case "tool_use":
        if (role === "user") rejectField(`${at}.content`, USER_TOOL_USE)
        flush()
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: argumentsFromInput(block.input),
        })
        break
      case "tool_result": {
        flush()
        const result = toolResultParts(block, field, onDrop)
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: result.text,
        })
        // Hoisted: a `function_call_output` holds text only, so the image becomes a user message
        // item right after it — see the openai-chat sibling for why that position.
        if (result.images.length > 0) {
          items.push({
            type: "message",
            role: "user",
            content: result.images.map((source) => ({
              type: "input_image",
              image_url: imageUrlFromSource(source),
            })),
          })
        }
        break
      }
      case "document": {
        const text = documentText(block, field, onDrop)
        if (text !== null && text.length > 0) parts.push({ type: textType, text })
        break
      }
      case "thinking":
      case "redacted_thinking":
        // Documented drop. Re-sending a reasoning block as plain text would put the model's own
        // scratchpad into the transcript as if a participant had said it.
        break
      default:
        // The provider's own artifacts (`server_tool_use`, `web_search_tool_result`, …), whose
        // visible outcome is already in the text blocks beside them.
        dropBlock(onDrop, field, block.actual, TARGET)
    }
  }

  flush()
}
