import { createAnthropicStreamEmitter } from "../shared/anthropic-stream"
import { responsesEventSchema } from "../shared/responses-read"
import { fromResponsesCompletion, toAnthropicStopReason } from "../shared/stop-reason"
import {
  anthropicUsageCounts,
  parseOpenAiResponsesUsage,
  responsesUsageToOpenAiChat,
} from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * A Responses SSE stream → Anthropic SSE events.
 *
 * The Anthropic event order is the verified one and is owned by `shared/anthropic-stream.ts`, which
 * emits it identically for every dialect translated into it
 * (docs/idea/06-protocol-translation.md#streaming-sse-event-mapping). What lives here is the
 * Responses half of the reading, and Responses is the **noisiest** of the three: it names an item,
 * then a content part inside it, then deltas, then a `.done` mirror of each — where Anthropic wants
 * one block open at a time. So only the events that carry new information are acted on. A text block
 * opens on its first `output_text.delta` rather than on the item that announced it, which is what
 * keeps an item that never produces text — a reasoning item — from costing the client an empty block.
 *
 * **A Responses stream names its event type twice**, on the `event:` line and again inside the data
 * object, and the payload is preferred for the same reason `anthropic-to-openai-chat/stream.ts`
 * prefers it: an intermediary is free to drop the `event:` line, and the object is the thing the
 * upstream actually serialized.
 *
 * Dropped, as documented: `response.reasoning_summary_text.delta`. Anthropic's `thinking` block
 * carries a `signature` only Anthropic can mint, so an unsigned one is content the client cannot
 * replay on its next turn — the same call `response.ts` makes about a finished reasoning item.
 */

/** Neither field is required: a compatible upstream names both on `response.created`. */
export interface OpenAiResponsesToAnthropicStreamOptions {
  /** Used until an event names the upstream's own id, and if none ever does. */
  readonly id?: string | undefined
  /** Used until an event names the model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function openAiResponsesToAnthropicStream(
  options: OpenAiResponsesToAnthropicStreamOptions = {},
): StreamTranslator {
  const emitter = createAnthropicStreamEmitter(options)
  let unrecognized: string | null = null
  // Responses reports a tool call by emitting a `function_call` item, never by naming a reason, so
  // the terminal stop reason depends on what came before it.
  let sawToolCall = false
  // Only ever reached by an upstream that keys a call with neither an item id nor an output index.
  let unkeyed = 0

  return {
    push(frame) {
      if (emitter.isTerminated()) return NO_EVENTS
      const payload = frameJson(frame)
      const parsed = responsesEventSchema.safeParse(payload)
      if (!parsed.success) return NO_EVENTS

      const event = parsed.data
      const out: SseEvent[] = []
      switch (event.type ?? frame.event) {
        case "response.created":
        case "response.in_progress":
          emitter.identify(event.response?.id, event.response?.model)
          emitter.start(out)
          break

        case "response.output_item.added": {
          const item = event.item
          if (item?.type === "function_call") {
            sawToolCall = true
            const stated = item.id ?? event.output_index ?? null
            // An unkeyed call gets an ordinal of its own, so a second one does not append its
            // arguments to the first one's block.
            if (stated === null) unkeyed += 1
            const key = stated ?? `item#${unkeyed}`
            emitter.toolStart(out, key, { id: item.call_id, name: item.name })
          }
          break
        }

        case "response.output_text.delta":
          // `start` is idempotent: a stream whose opening event was lost still gets `message_start`
          // before its first content, which a client reading the sequence is entitled to.
          emitter.start(out)
          emitter.text(out, event.delta ?? "")
          break

        case "response.function_call_arguments.delta": {
          // The same key the `added` event was read with, so the deltas find their own block.
          const key = event.item_id ?? event.output_index ?? `item#${unkeyed}`
          emitter.toolArgs(out, key, event.delta ?? "")
          break
        }

        case "response.output_item.done":
          emitter.closeBlock(out)
          break

        case "response.completed":
        case "response.incomplete": {
          const response = event.response
          const finish = fromResponsesCompletion(
            response?.status,
            response?.incomplete_details?.reason,
            sawToolCall,
          )
          const stop = toAnthropicStopReason(finish.value)
          unrecognized = finish.unrecognized ?? stop.unrecognized ?? unrecognized
          const usage = parseOpenAiResponsesUsage(response?.usage)
          const counts = usage === null ? null : responsesUsageToOpenAiChat(usage)
          emitter.terminate(out, { stopReason: stop.value, usage: anthropicUsageCounts(counts) })
          break
        }

        case "response.failed":
          // The response object carries the upstream's own error; the event itself is the fallback.
          emitter.fail(out, event.response?.error ?? payload)
          break

        case "error":
          emitter.fail(out, payload)
          break

        default:
          // `response.content_part.*`, every `.done` mirror of a delta already forwarded, the
          // reasoning summary deltas, and anything OpenAI adds after this was written.
          return NO_EVENTS
      }
      return out
    },

    /**
     * Always nothing.
     *
     * The Anthropic terminator — `message_delta` carrying the stop reason and usage, then
     * `message_stop` — is emitted on the completion event itself, so a stream that reached one is
     * already whole. A stream that did not was truncated, and **a truncated stream is never given a
     * synthesized ending** (`06-protocol-translation.md#streaming-sse-event-mapping`): manufacturing
     * one would report a completion that never happened, on a request whose bytes are already gone.
     */
    flush: () => NO_EVENTS,

    unrecognizedStopReason: () => unrecognized,
  }
}
