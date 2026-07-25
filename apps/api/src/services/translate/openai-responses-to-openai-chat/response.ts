import type { OpenAiChatToolCall } from "../shared/openai-chat"
import type { TranslatedResponse } from "../shared/response"
import { readResponsesBody } from "../shared/responses-read"
import { fromResponsesCompletion } from "../shared/stop-reason"
import { responsesUsageToOpenAiChat } from "../shared/usage"

/**
 * A non-streaming openai-responses `response` object → a `chat.completion` object. The **downgrade**
 * direction of the matrix (docs/idea/06-protocol-translation.md#translation-matrix, legend): the
 * richer dialect read back in the poorer one.
 *
 * **Nothing here throws**, the same rule the streaming half obeys. The upstream already answered —
 * the request succeeded, was billed, and cannot be retried onto another account — so a field this
 * module cannot read is reported as absent rather than turned into a failure the caller has no way
 * to act on (`06-protocol-translation.md`, "Rejected: nothing at stream time"). The refusals of this
 * pair all belong to `request.ts` and all happen before the upstream call.
 *
 * Responses states an ordered array of typed *items* where openai-chat states one message, so the
 * array collapses: `message` items concatenate into `message.content`, `function_call` items become
 * `tool_calls[]`, and `reasoning` items are **dropped** as documented — openai-chat has no
 * reasoning-summary field, exactly as it has none for an Anthropic `thinking` block. A completion
 * carrying only tool calls states `content: null`, which is how OpenAI itself spells it: an empty
 * string there reads as "the model said nothing out loud", a different claim.
 *
 * The finish reason is the one place two Responses fields become one. `status` plus
 * `incomplete_details.reason` are read by `shared/stop-reason.ts`, together with whether any
 * function call was seen — Responses says "the model called a tool" by emitting an item and never by
 * naming a reason, so a translation that ignored the items would report every tool call as text.
 */

/**
 * Two `message` items are two separate things the model said, so they join on a newline rather than
 * on nothing: gluing the end of one to the start of the next would invent a sentence. Same separator
 * `shared/responses-read.ts` already uses between the parts *inside* one item, so the two levels of
 * flattening agree.
 */
const ITEM_JOIN = "\n"

export interface OpenAiResponsesToOpenAiChatResponseOptions {
  /** Unix **seconds**. A caller-supplied value, never `Date.now()`: a translator holds no clock. */
  readonly created: number
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function openAiResponsesToOpenAiChatResponse(
  body: unknown,
  options: OpenAiResponsesToOpenAiChatResponseOptions,
): TranslatedResponse {
  const read = readResponsesBody(body)

  const texts: string[] = []
  const toolCalls: OpenAiChatToolCall[] = []
  for (const item of read.items) {
    if (item.kind === "text") {
      texts.push(item.text)
      continue
    }
    // `reasoning` falls through here: dropped, as documented.
    if (item.kind !== "function_call") continue
    toolCalls.push({
      id: item.callId,
      type: "function",
      function: { name: item.name, arguments: item.arguments },
    })
  }

  const stop = fromResponsesCompletion(read.status, read.incompleteReason, toolCalls.length > 0)

  return {
    body: {
      // Ids pass through verbatim so one completion is traceable across the seam.
      id: read.id ?? options.id ?? "",
      object: "chat.completion",
      created: options.created,
      model: read.model ?? options.model ?? "",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: texts.length === 0 ? null : texts.join(ITEM_JOIN),
            ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          },
          finish_reason: stop.value,
        },
      ],
      // Omitted rather than zeroed when the upstream counted nothing: a completion whose cost nobody
      // measured must not report as free.
      ...(read.usage === null ? {} : { usage: responsesUsageToOpenAiChat(read.usage) }),
    },
    unrecognizedStopReason: stop.unrecognized,
  }
}
