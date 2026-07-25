import { z } from "zod"
import type { TranslatedResponse } from "../shared/response"
import type { ResponsesOutputItem } from "../shared/responses-body"
import { responsesBodyJson, responsesItemId } from "../shared/responses-body"
import { toOpenAiFinishReason, toResponsesCompletion } from "../shared/stop-reason"
import { openAiChatUsageToResponses, parseAnthropicUsage, usageToOpenAiChat } from "../shared/usage"

/**
 * A non-streaming Anthropic `Message` → a Responses `response` object.
 *
 * The mirror of `stream.ts` for the request that did not ask to stream, and it obeys the same rule
 * the streaming half does. **Nothing here throws.** The upstream already answered — the request
 * succeeded, was billed, and cannot be retried onto another account — so a field this module cannot
 * read is reported as absent rather than turned into a failure the caller has no way to act on
 * (`docs/idea/06-protocol-translation.md`, "Rejected: nothing at stream time").
 *
 * Both dialects have a block concept, so this is the one seam where the content array survives as
 * structure rather than collapsing: **each Anthropic block becomes one output item, in order.** One
 * block to one item rather than a run of text blocks joined into one message item, because the
 * streaming half closes an item on `content_block_stop` — the boundary Anthropic itself states — and
 * a client reading the final object and a client reading the deltas of the same answer must be told
 * the same thing (`06-protocol-translation.md#streaming-sse-event-mapping`). Item ids are ours,
 * derived from the response id and the item's position; no Anthropic block names one.
 *
 * `stop_reason` lands in the two fields Responses splits it across, `status` and
 * `incomplete_details.reason`; `redacted_thinking` is dropped, having no summary to carry.
 */

const contentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().nullish().catch(null),
  thinking: z.string().nullish().catch(null),
  id: z.string().nullish().catch(null),
  name: z.string().nullish().catch(null),
  input: z.unknown().optional(),
})

const messageSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  content: z.array(contentBlockSchema).nullish().catch(null),
  stop_reason: z.string().nullish().catch(null),
  usage: z.unknown().optional(),
})

export interface AnthropicToOpenAiResponsesResponseOptions {
  /** Unix **seconds**. A caller-supplied value, never `Date.now()`: a translator holds no clock. */
  readonly created: number
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function anthropicToOpenAiResponsesResponse(
  body: unknown,
  options: AnthropicToOpenAiResponsesResponseOptions,
): TranslatedResponse {
  const parsed = messageSchema.safeParse(body)
  const message = parsed.success ? parsed.data : null
  // Ids pass through verbatim so one response is traceable across the seam, and the item ids below
  // are derived from this one, which keeps them traceable too.
  const id = message?.id ?? options.id ?? ""

  const items: ResponsesOutputItem[] = []

  for (const block of message?.content ?? []) {
    if (block.type === "text") {
      // An empty block opens no item, which is the same call the streaming half makes about an
      // empty delta: Responses has no way to say "the model said nothing here".
      const text = block.text ?? ""
      if (text.length > 0) {
        items.push({ type: "message", id: responsesItemId("message", id, items.length), text })
      }
      continue
    }
    if (block.type === "tool_use") {
      items.push({
        type: "function_call",
        id: responsesItemId("function_call", id, items.length),
        call_id: block.id ?? "",
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      })
      continue
    }
    // A `thinking` block's text is the summary Responses carries. The encrypted reasoning handle a
    // native Responses upstream would also emit cannot be synthesized, and is not.
    if (block.type !== "thinking") continue
    const summary = block.thinking ?? ""
    if (summary.length === 0) continue
    items.push({ type: "reasoning", id: responsesItemId("reasoning", id, items.length), summary })
  }

  const stop = toOpenAiFinishReason(message?.stop_reason)
  const completion = toResponsesCompletion(stop.value)
  const usage = parseAnthropicUsage(message?.usage)

  return {
    body: responsesBodyJson({
      id,
      model: message?.model ?? options.model ?? "",
      created: options.created,
      status: completion.status,
      incompleteReason: completion.incompleteReason,
      items,
      // Through the openai-chat shape deliberately: the Anthropic arithmetic — three input fields
      // summed into one prompt total — is stated once there, and restating it would let one copy
      // drift (`06-protocol-translation.md#usage-and-token-fields`). Null when nobody counted.
      usage: usage === null ? null : openAiChatUsageToResponses(usageToOpenAiChat(usage)),
    }),
    unrecognizedStopReason: stop.unrecognized,
  }
}
