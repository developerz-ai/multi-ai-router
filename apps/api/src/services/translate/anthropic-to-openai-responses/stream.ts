import { z } from "zod"
import { createResponsesStreamEmitter } from "../shared/responses-stream"
import { toOpenAiFinishReason, toResponsesCompletion } from "../shared/stop-reason"
import type { AnthropicUsage } from "../shared/usage"
import { openAiChatUsageToResponses, parseAnthropicUsage, usageToOpenAiChat } from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * An Anthropic SSE stream → openai-responses SSE events.
 *
 * The Anthropic order is the verified one and every event has a row in the table at
 * `docs/idea/06-protocol-translation.md#streaming-sse-event-mapping`:
 *
 * ```
 * message_start → content_block_start → content_block_delta* → content_block_stop
 *               → message_delta (stop_reason + usage.output_tokens) → message_stop
 * ```
 *
 * **`stop_reason` and `usage.output_tokens` arrive on `message_delta`, not `message_stop`.** A
 * translator that waits for them on `message_stop` emits a terminal object with no status and no
 * token counts, which is the single most likely way to get this direction wrong.
 *
 * This is the seam where the two dialects agree most: **both stream in blocks**, so
 * `content_block_stop` is forwarded as the item boundary rather than reconstructed — Anthropic
 * states exactly the fact a Responses item needs to be closed. `shared/responses-stream.ts` owns the
 * event vocabulary on the far side, as it does for every dialect translated into Responses, and what
 * lives here is only the Anthropic half of the reading. `thinking_delta` finally has somewhere to
 * go: the spec's table maps it to `response.reasoning_summary_text.delta`, where translating toward
 * openai-chat has to drop it.
 *
 * The event schemas below are this module's own reading of the Anthropic wire, not a shared one.
 * They are small, and a pair that owns its reading cannot have a field added for another pair's
 * benefit change what this one accepts.
 */

/** `created` is a caller-supplied value, never `Date.now()`: a translator holds no clock. */
export interface AnthropicToOpenAiResponsesStreamOptions {
  /** Unix **seconds**, stamped as `created_at` on every restated response object. */
  readonly created: number
  /** Used until `message_start` names the upstream's own id, and if it never does. */
  readonly id?: string | undefined
  /** Used until `message_start` names the model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

const messageStartSchema = z.looseObject({
  message: z
    .looseObject({
      id: z.string().nullish().catch(null),
      model: z.string().nullish().catch(null),
      usage: z.unknown().optional(),
    })
    .nullish(),
})

const blockStartSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  content_block: z.looseObject({
    type: z.string(),
    text: z.string().nullish().catch(null),
    id: z.string().nullish().catch(null),
    name: z.string().nullish().catch(null),
  }),
})

const blockDeltaSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  delta: z.looseObject({
    type: z.string(),
    text: z.string().nullish().catch(null),
    thinking: z.string().nullish().catch(null),
    partial_json: z.string().nullish().catch(null),
  }),
})

const messageDeltaSchema = z.looseObject({
  delta: z.looseObject({ stop_reason: z.string().nullish().catch(null) }).nullish(),
  usage: z.unknown().optional(),
})

export function anthropicToOpenAiResponsesStream(
  options: AnthropicToOpenAiResponsesStreamOptions,
): StreamTranslator {
  const emitter = createResponsesStreamEmitter(options)
  let startUsage: AnthropicUsage | null = null
  let unrecognized: string | null = null

  function onMessageStart(out: SseEvent[], payload: unknown): void {
    const parsed = messageStartSchema.safeParse(payload)
    const message = parsed.success ? parsed.data.message : null
    // Identified before the stream opens, so `response.created` carries the upstream's own id: a
    // minted one would make the router's view and the client's view of one response disagree.
    emitter.identify(message?.id, message?.model)
    emitter.start(out)
    startUsage = parseAnthropicUsage(message?.usage)
  }

  function onBlockStart(out: SseEvent[], payload: unknown): void {
    const parsed = blockStartSchema.safeParse(payload)
    if (!parsed.success) return
    const { index, content_block: block } = parsed.data

    if (block.type === "tool_use") {
      // Keyed by Anthropic's own block index, which every delta for this call repeats.
      emitter.toolStart(out, index, { id: block.id, name: block.name })
      return
    }
    // A text block's `start` may already carry text. A `thinking` block's start carries none, and
    // anything a future model adds has no item to open until it says something.
    if (block.type === "text") emitter.text(out, block.text ?? "")
  }

  function onBlockDelta(out: SseEvent[], payload: unknown): void {
    const parsed = blockDeltaSchema.safeParse(payload)
    if (!parsed.success) return
    const { index, delta } = parsed.data

    if (delta.type === "text_delta") {
      emitter.text(out, delta.text ?? "")
      return
    }
    if (delta.type === "thinking_delta") {
      emitter.reasoning(out, delta.thinking ?? "")
      return
    }
    if (delta.type === "input_json_delta") emitter.toolArgs(out, index, delta.partial_json ?? "")
  }

  /**
   * The terminal object: the status, the incompleteness reason, and the token counts.
   *
   * A count the upstream never sent stays null rather than becoming a zero
   * (`06-protocol-translation.md#usage-and-token-fields`), and the counts go through the openai-chat
   * shape so the Anthropic prompt arithmetic is stated in exactly one place.
   */
  function onMessageDelta(out: SseEvent[], payload: unknown): void {
    const parsed = messageDeltaSchema.safeParse(payload)
    if (!parsed.success) return

    const mapped = toOpenAiFinishReason(parsed.data.delta?.stop_reason)
    unrecognized = mapped.unrecognized ?? unrecognized
    const completion = toResponsesCompletion(mapped.value)
    const usage = mergeUsage(startUsage, parseAnthropicUsage(parsed.data.usage))

    emitter.complete(out, {
      status: completion.status,
      incompleteReason: completion.incompleteReason,
      usage: usage === null ? null : openAiChatUsageToResponses(usageToOpenAiChat(usage)),
    })
  }

  return {
    push(frame) {
      if (emitter.isTerminated()) return NO_EVENTS
      const payload = frameJson(frame)
      const out: SseEvent[] = []

      switch (eventType(frame.event, payload)) {
        case "message_start":
          onMessageStart(out, payload)
          break
        case "content_block_start":
          onBlockStart(out, payload)
          break
        case "content_block_delta":
          onBlockDelta(out, payload)
          break
        case "content_block_stop":
          // Forwarded, not reconstructed: Anthropic states the boundary, and a Responses item needs
          // exactly that to close with its `done` events before the next one opens.
          emitter.closeItem(out)
          break
        case "message_delta":
          onMessageDelta(out, payload)
          break
        case "message_stop":
          // Nothing is owed. `response.completed` went out on `message_delta`, which is where
          // Anthropic states the stop reason and the token counts a Responses client reads off it.
          // A `message_stop` with no `message_delta` before it means the stream was truncated, and
          // that gets no synthesized ending.
          break
        case "error":
          emitter.fail(out, payload)
          break
        default:
          // `ping`, and anything Anthropic adds after this was written.
          break
      }
      return out
    },

    flush() {
      // Nothing is ever owed here, unlike the openai-chat direction: `[DONE]` is a separate sentinel
      // that can go missing on its own, while the Responses terminator *is* `response.completed` —
      // already emitted the moment the finish reason landed. A stream that ended before stating one
      // was truncated, and a synthesized ending would report a completion that never happened.
      return NO_EVENTS
    },

    unrecognizedStopReason: () => unrecognized,
  }
}

function eventType(name: string | null, payload: unknown): string | null {
  if (typeof payload === "object" && payload !== null && "type" in payload) {
    const type = (payload as { type: unknown }).type
    if (typeof type === "string") return type
  }
  return name
}

/** The final counts win field by field: `message_start` states input, `message_delta` output. */
function mergeUsage(
  start: AnthropicUsage | null,
  end: AnthropicUsage | null,
): AnthropicUsage | null {
  if (start === null) return end
  if (end === null) return start
  return {
    input_tokens: end.input_tokens ?? start.input_tokens,
    output_tokens: end.output_tokens ?? start.output_tokens,
    cache_creation_input_tokens:
      end.cache_creation_input_tokens ?? start.cache_creation_input_tokens,
    cache_read_input_tokens: end.cache_read_input_tokens ?? start.cache_read_input_tokens,
  }
}
