import { createAnthropicStreamEmitter } from "../shared/anthropic-stream"
import { responsesFinalEvents } from "../shared/responses-final-events"
import { createResponsesItemIdentity } from "../shared/responses-item-identity"
import { type ParsedResponsesEvent, responsesEventSchema } from "../shared/responses-read"
import {
  createResponsesSnapshotRecovery,
  type ResponsesRecoveryOptions,
} from "../shared/responses-snapshot-recovery"
import {
  createResponsesTextBoundary,
  validResponsesTextIdentity,
} from "../shared/responses-text-boundary"
import { fromResponsesCompletion, toAnthropicStopReason } from "../shared/stop-reason"
import { TranslationStreamError } from "../shared/stream-error"
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
 * `response.reasoning_summary_text.delta` opens a `thinking` block, closed with the router's
 * `signature_delta` (`shared/router-thinking.ts`) — the same call `response.ts` makes about a
 * finished reasoning item. A second summary part of the same item continues the block after a
 * newline, the join the non-streaming reading uses.
 */

/** Neither field is required: a compatible upstream names both on `response.created`. */
export interface OpenAiResponsesToAnthropicStreamOptions extends ResponsesRecoveryOptions {
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
  let failure: Error | null = null
  // Responses reports a tool call by emitting a `function_call` item, never by naming a reason, so
  // the terminal stop reason depends on what came before it.
  let sawToolCall = false
  // Only ever reached by an upstream that keys a call with neither an item id nor an output index.
  let unkeyed = 0
  const knownCalls = new Set<string | number>()
  const resolveIdentity = createResponsesItemIdentity(options)
  const textBoundary = createResponsesTextBoundary()
  const recoverSnapshot = createResponsesSnapshotRecovery(options)
  const summaryBoundary = createSummaryBoundary()

  function process(payload: unknown, fallbackType: string | null): readonly SseEvent[] {
    if (emitter.isTerminated()) return NO_EVENTS
    if (!validResponsesTextIdentity(payload, fallbackType)) return NO_EVENTS
    const identity = resolveIdentity({
      ...(payload as Record<string, unknown>),
      type: (payload as { type?: unknown })?.type ?? fallbackType,
    })
    if (identity.error) {
      failure = new TranslationStreamError(
        identity.errorClass ?? "translation_protocol_error",
        identity.error,
      )
      const out: SseEvent[] = []
      emitter.fail(out, {
        message: identity.error,
        code: identity.errorClass ?? "translation_protocol_error",
      })
      return out
    }
    const raw = identity.event
    const rawType = raw.type
    if (typeof rawType === "string" && rawType.startsWith("response.function_call_arguments.")) {
      const key = raw?.item_id ?? raw?.output_index ?? `item#${unkeyed}`
      if ((typeof key !== "string" && typeof key !== "number") || !knownCalls.has(key))
        return NO_EVENTS
    }
    const recovery = recoverSnapshot(raw)
    if (recovery.error) {
      failure = new TranslationStreamError(
        recovery.errorClass ?? "translation_protocol_error",
        recovery.error,
      )
      const out: SseEvent[] = []
      emitter.fail(out, {
        message: recovery.error,
        code: recovery.errorClass ?? "translation_protocol_error",
      })
      return out
    }
    const parsed = responsesEventSchema.safeParse(recovery.event)
    if (!parsed.success) return NO_EVENTS

    const event = parsed.data
    const out: SseEvent[] = []
    switch (event.type ?? fallbackType) {
      case "response.created":
      case "response.in_progress":
        emitter.identify(event.response?.id, event.response?.model)
        emitter.start(out)
        break

      case "response.output_item.added": {
        const item = event.item
        if (item?.type === "function_call") {
          emitter.start(out)
          sawToolCall = true
          const stated = item.id ?? event.output_index ?? null
          // An unkeyed call gets an ordinal of its own, so a second one does not append its
          // arguments to the first one's block.
          if (stated === null) unkeyed += 1
          const key = stated ?? `item#${unkeyed}`
          knownCalls.add(key)
          emitter.toolStart(out, key, { id: item.call_id, name: item.name })
        }
        break
      }

      case "response.output_text.delta":
      case "response.refusal.delta":
        // `start` is idempotent: a stream whose opening event was lost still gets `message_start`
        // before its first content, which a client reading the sequence is entitled to.
        {
          const boundary = textBoundary(event)
          if (boundary === null) break
          emitter.start(out)
          emitter.text(
            out,
            `${boundary.separator && !boundary.newItem ? "\n" : ""}${boundary.text}`,
            boundary.newItem,
          )
        }
        break

      case "response.reasoning_summary_text.delta": {
        const boundary = summaryBoundary(event)
        if (boundary === null) break
        emitter.start(out)
        emitter.text(out, boundary.text, boundary.newItem, "reasoning")
        break
      }

      case "response.function_call_arguments.delta": {
        // The same key the `added` event was read with, so the deltas find their own block.
        const key = event.item_id ?? event.output_index ?? `item#${unkeyed}`
        emitter.toolArgs(out, key, event.delta ?? "")
        break
      }

      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          const key = event.item.id ?? event.output_index ?? `item#${unkeyed}`
          emitter.toolDone(out, key)
        } else emitter.closeTextBlock(out)
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
  }

  return {
    push(frame) {
      return responsesFinalEvents(frameJson(frame)).flatMap((payload) =>
        process(payload, frame.event),
      )
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
    translationFailure: () => failure ?? emitter.translationFailure(),
  }
}

/** Where a summary delta sits: a new reasoning item opens a block, a new part adds a newline. */
function createSummaryBoundary() {
  let previous: { item: string | number | null; part: number | null } | undefined
  return (event: ParsedResponsesEvent): { text: string; newItem: boolean } | null => {
    const delta = event.delta ?? ""
    if (delta.length === 0) return null
    const item = event.item_id ?? event.output_index ?? null
    const part = event.summary_index ?? null
    const newItem = previous === undefined || previous.item !== item
    const newPart = !newItem && previous?.part !== part
    previous = { item, part }
    return { text: newPart ? `\n${delta}` : delta, newItem }
  }
}
