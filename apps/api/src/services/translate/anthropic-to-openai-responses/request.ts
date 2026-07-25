import type { ParsedAnthropicBlock, ParsedAnthropicMessage } from "../shared/anthropic"
import { anthropicRequestSchema } from "../shared/anthropic"
import { imageUrlFromSource, systemText, toolResultText } from "../shared/anthropic-blocks"
import type {
  OpenAiResponsesItem,
  OpenAiResponsesPart,
  OpenAiResponsesRequest,
} from "../shared/openai-responses"
import { assertNoStopSequence, parseRequest, rejectField } from "../shared/reject"
import {
  argumentsFromInput,
  toolChoiceToOpenAiChat,
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
 * Dropped, as documented: `top_k`, `cache_control`, `thinking` / `redacted_thinking` blocks,
 * `metadata`, and any `anthropic-beta` opt-in (a header, handled by the transport). Refused:
 * `stop_sequences`, server-side tools, an image the target cannot carry, and any block with no item
 * or content part to land in — a contract field is never dropped quietly.
 */

/** What a refusal calls the thing an Anthropic `tool_result` lands in on this side. */
const TOOL_CARRIER = "an openai-responses `function_call_output` item"

const USER_TOOL_USE =
  "carries a `tool_use` block on a user turn, which openai-responses cannot express"

const ASSISTANT_IMAGE =
  "is an `image` block on an assistant turn, which openai-responses cannot express: assistant content holds `output_text` and `refusal` only"

/** @throws TranslationError (400) naming the field that has no openai-responses representation. */
export function anthropicToOpenAiResponsesRequest(body: unknown): OpenAiResponsesRequest {
  const request = parseRequest(anthropicRequestSchema, body, "anthropic")

  // openai-responses states no stop parameter at all, and `shared/reject.ts` owns that rule for both
  // dialects that spell it — the same field under two names cannot be servable from one and not the
  // other.
  assertNoStopSequence(request.stop_sequences, "stop_sequences")

  const input: OpenAiResponsesItem[] = []
  for (const [index, message] of request.messages.entries()) {
    appendMessage(input, message, `messages[${index}]`)
  }

  const instructions = systemText(request.system)

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
    // Through the openai-chat shape deliberately: the two differ by one level of nesting, and a
    // second path would be a second copy of the JSON-Schema validation that could disagree with it.
    tools:
      request.tools === undefined
        ? undefined
        : toolsToOpenAiResponses(toolsToOpenAiChat(request.tools)),
    tool_choice:
      request.tool_choice === undefined
        ? undefined
        : toolChoiceToOpenAiResponses(toolChoiceToOpenAiChat(request.tool_choice)),
    // The router holds no conversation state and an Anthropic client has no way to name a stored
    // response on its next turn, so one left behind is litter nobody can reference or delete.
    store: false,
  }
}

function appendMessage(
  items: OpenAiResponsesItem[],
  message: ParsedAnthropicMessage,
  at: string,
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
      case "tool_result":
        flush()
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: toolResultText(block, field, TOOL_CARRIER),
        })
        break
      case "thinking":
      case "redacted_thinking":
        // Documented drop. Re-sending a reasoning block as plain text would put the model's own
        // scratchpad into the transcript as if a participant had said it.
        break
      default:
        rejectField(`${field}.type`, `\`${block.actual}\` has no openai-responses counterpart`)
    }
  }

  flush()
}
