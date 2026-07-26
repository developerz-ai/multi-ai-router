import { z } from "zod"
import { openAiChatReasoningSchema, readOpenAiChatReasoning } from "../shared/openai-chat-reasoning"
import { createOpenAiChatToolCallReader } from "../shared/openai-chat-tool-calls"
import { createResponsesStreamEmitter } from "../shared/responses-stream"
import { readOpenAiFinishReason, toResponsesCompletion } from "../shared/stop-reason"
import type { OpenAiChatUsage } from "../shared/usage"
import { openAiChatUsageToResponses, parseOpenAiChatUsage } from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * A `chat.completion.chunk` stream → openai-responses SSE events.
 *
 * The item structure Responses requires is invented by `shared/responses-stream.ts`, which owns the
 * event order for every dialect translated into it. What lives here is the openai-chat half of the
 * reading, and it is the same structural problem the anthropic sibling documents: openai-chat has no
 * item concept at all — text arrives as `delta.content`, calls as `delta.tool_calls[]` keyed by an
 * index that counts only calls, with no start, no stop, and no ordering between the two — so item
 * boundaries are **invented**: one open item at a time, closed the moment the content switches kind.
 * That index an upstream may revisit, or omit entirely; `shared/openai-chat-tool-calls.ts` owns the
 * keying that survives both.
 *
 * **The terminal event waits for the end of the stream, and only the terminal event.** openai-chat
 * puts `finish_reason` on one chunk and — with `stream_options.include_usage` — the token counts on
 * a *later* chunk carrying no choices at all, so `response.completed` cannot be emitted the instant
 * a finish reason lands without reporting a response with no tokens. Content deltas are never held:
 * every one leaves as it arrives.
 *
 * **This is the direction a reasoning model's thinking survives.** DeepSeek-R1, QwQ, GLM and every
 * other reasoning model reached over openai-chat stream their thinking beside the answer, under a
 * name OpenAI never published; `shared/openai-chat-reasoning.ts` owns which names those are, and
 * Responses has an item type waiting for the text. Toward `anthropic` the same deltas are dropped,
 * because a `thinking` block a client can replay needs a `signature` this router cannot produce.
 */

export interface OpenAiChatToOpenAiResponsesStreamOptions {
  /** Unix **seconds**, stamped as `created_at`. Supplied by the caller: a translator holds no clock. */
  readonly created: number
  /** Used until a chunk names the upstream's own id, and if none ever does. */
  readonly id?: string | undefined
  /** Used until a chunk names the model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

const DONE_SENTINEL = "[DONE]"

const toolCallSchema = z.looseObject({
  index: z.number().int().nonnegative().nullish().catch(null),
  id: z.string().nullish().catch(null),
  function: z
    .looseObject({
      name: z.string().nullish().catch(null),
      arguments: z.string().nullish().catch(null),
    })
    .nullish()
    .catch(null),
})

const chunkSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  choices: z
    .array(
      z.looseObject({
        index: z.number().int().nullish().catch(null),
        delta: z
          .looseObject({
            content: z.string().nullish().catch(null),
            ...openAiChatReasoningSchema,
            tool_calls: z.array(toolCallSchema).nullish().catch(null),
          })
          .nullish()
          .catch(null),
        finish_reason: z.string().nullish().catch(null),
      }),
    )
    .nullish()
    .catch(null),
  usage: z.unknown().optional(),
})

export function openAiChatToOpenAiResponsesStream(
  options: OpenAiChatToOpenAiResponsesStreamOptions,
): StreamTranslator {
  const emitter = createResponsesStreamEmitter(options)
  const toolCalls = createOpenAiChatToolCallReader()
  let finishReason: string | null = null
  let usage: OpenAiChatUsage | null = null
  let unrecognized: string | null = null

  function terminate(out: SseEvent[]): void {
    const mapped = readOpenAiFinishReason(finishReason)
    unrecognized = mapped.unrecognized ?? unrecognized
    emitter.complete(out, {
      ...toResponsesCompletion(mapped.value),
      usage: usage === null ? null : openAiChatUsageToResponses(usage),
    })
  }

  return {
    push(frame) {
      if (emitter.isTerminated()) return NO_EVENTS
      const out: SseEvent[] = []
      if (frame.data === DONE_SENTINEL) {
        terminate(out)
        return out
      }

      const payload = frameJson(frame)
      if (payload === null || typeof payload !== "object") return NO_EVENTS
      if ("error" in payload) {
        emitter.fail(out, payload)
        return out
      }

      const parsed = chunkSchema.safeParse(payload)
      if (!parsed.success) return NO_EVENTS
      emitter.identify(parsed.data.id, parsed.data.model)
      usage = parseOpenAiChatUsage(parsed.data.usage) ?? usage

      // `n > 1` is refused at request time, so the one choice a translated stream can carry is the
      // first; an upstream that answers with more anyway has its extras dropped, not interleaved.
      const choice = (parsed.data.choices ?? []).find((entry) => (entry.index ?? 0) === 0)
      if (choice === undefined) return out

      emitter.start(out)
      // Before the text, which is the order a reasoning model produces the two in and the order
      // Responses states its items: an upstream that thinks out loud has already finished doing so
      // by the time it starts answering.
      emitter.reasoning(out, readOpenAiChatReasoning(choice.delta))
      emitter.text(out, choice.delta?.content ?? "")
      for (const call of choice.delta?.tool_calls ?? []) {
        const key = toolCalls.key(call)
        emitter.toolStart(out, key, { id: call.id, name: call.function?.name })
        emitter.toolArgs(out, key, call.function?.arguments ?? "")
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason
        // The item is closed here rather than at termination: a finish reason means no further
        // content, and the client learns the item ended without waiting for the usage chunk.
        emitter.closeItem(out)
      }
      return out
    },

    flush() {
      // A stream that ended without a finish reason was truncated. Synthesizing `response.completed`
      // for it would report a response that never happened.
      if (emitter.isTerminated() || finishReason === null) return NO_EVENTS
      const out: SseEvent[] = []
      terminate(out)
      return out
    },

    unrecognizedStopReason: () => unrecognized,
  }
}
