import type { AnthropicTextBlock, AnthropicToolUseBlock } from "../shared/anthropic"
import type { TranslatedResponse } from "../shared/response"
import { readResponsesBody } from "../shared/responses-read"
import { fromResponsesCompletion, toAnthropicStopReason } from "../shared/stop-reason"
import { anthropicUsageCounts, responsesUsageToOpenAiChat } from "../shared/usage"

/**
 * A non-streaming Responses object → an Anthropic `Message`.
 *
 * Unlike the openai-chat sibling, this direction **invents no ordering**: Responses already states
 * an ordered `output` array, so the block sequence a client reads is the one the model produced
 * rather than one this module reconstructed. `shared/responses-read.ts` does the flattening, because
 * every dialect Responses is translated into needs the same array read the same way.
 *
 * **Nothing here throws.** The upstream already answered, so a malformed field is reported as absent
 * rather than turned into a failure on a request that cannot be retried
 * (`docs/idea/06-protocol-translation.md`, "Rejected: nothing at stream time"). That is the one place
 * this module differs from `request.ts`, where the same undecodable `arguments` string is a `400`
 * naming the call: there, nothing has happened yet and refusing costs the caller nothing.
 *
 * **A `reasoning` item is dropped, not carried.** An Anthropic `thinking` block a client can replay
 * on its next turn needs a `signature` only Anthropic can mint, and this router has no way to produce
 * one. Emitting an unsigned block would hand the client content it cannot send back — a turn that
 * fails on the following request rather than on this one, which is the worse of the two failures.
 */

export interface OpenAiResponsesToAnthropicResponseOptions {
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function openAiResponsesToAnthropicResponse(
  body: unknown,
  options: OpenAiResponsesToAnthropicResponseOptions = {},
): TranslatedResponse {
  const read = readResponsesBody(body)

  const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = []
  for (const item of read.items) {
    // A `reasoning` item is dropped, for the reason above. An item that flattened to no text is
    // already absent, so no empty text block can be built here — Anthropic rejects one.
    if (item.kind === "text") content.push({ type: "text", text: item.text })
    if (item.kind === "function_call") {
      content.push({
        type: "tool_use",
        id: item.callId,
        name: item.name,
        input: toolInput(item.arguments),
      })
    }
  }

  // Responses says "the model called a tool" by emitting a `function_call` item and never by naming
  // a reason, so the items are what decide the stop reason, not `status` alone.
  const hasToolCall = read.items.some((item) => item.kind === "function_call")
  const finish = fromResponsesCompletion(read.status, read.incompleteReason, hasToolCall)
  const stop = toAnthropicStopReason(finish.value)
  const usage = read.usage === null ? null : responsesUsageToOpenAiChat(read.usage)

  return {
    body: {
      id: read.id ?? options.id ?? "",
      type: "message",
      role: "assistant",
      model: read.model ?? options.model ?? "",
      content,
      stop_reason: stop.value,
      // Lossy, and documented: openai-responses has no field naming *which* sequence matched.
      stop_sequence: null,
      usage: anthropicUsageCounts(usage),
    },
    // The unrecognized value can only come from the first hop — the second reads a finish reason
    // this build produced — but both are consulted so neither table can drift out unreported.
    unrecognizedStopReason: finish.unrecognized ?? stop.unrecognized,
  }
}

/**
 * `arguments` (a JSON string) → `input` (an object), best effort.
 *
 * An upstream that answered with a call whose arguments do not decode is broken, and there is no way
 * to say so in the shape — Anthropic's `input` has no array, scalar, or error form. An empty object
 * is the only representable answer; it is not a silent success, because the accompanying
 * `stop_reason: "tool_use"` still tells the client a call was made.
 */
function toolInput(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return {}
  return decoded as Record<string, unknown>
}
