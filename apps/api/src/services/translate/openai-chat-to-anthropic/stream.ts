import { z } from "zod"
import { createAnthropicStreamEmitter } from "../shared/anthropic-stream"
import { createOpenAiChatToolCallReader } from "../shared/openai-chat-tool-calls"
import { CONSERVATIVE_STOP_REASON, toAnthropicStopReason } from "../shared/stop-reason"
import type { OpenAiChatUsage } from "../shared/usage"
import { anthropicUsageCounts, parseOpenAiChatUsage } from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * A `chat.completion.chunk` stream → Anthropic SSE events.
 *
 * The block structure Anthropic requires is invented by `shared/anthropic-stream.ts`, which owns the
 * verified event order for every dialect translated into it. What lives here is the openai-chat half
 * of the reading: text arrives as `delta.content`, calls as `delta.tool_calls[]` keyed by an index
 * that counts only calls, with no start, no stop, and no ordering between the two — and which an
 * upstream may revisit, or omit entirely. `shared/openai-chat-tool-calls.ts` owns that keying.
 *
 * **The terminal events wait for the end of the stream, and only the terminal events.** openai-chat
 * puts `finish_reason` on one chunk and — with `stream_options.include_usage` — the token counts on
 * a *later* chunk carrying no choices at all, so `message_delta` cannot be emitted the instant a
 * finish reason lands without reporting a completion with no tokens. Content deltas are never held:
 * every one leaves as it arrives.
 *
 * **A reasoning model's thinking is dropped here, and carried toward openai-responses.** DeepSeek-R1,
 * QwQ and GLM stream it beside the answer under names `shared/openai-chat-reasoning.ts` lists, and
 * Anthropic states a `thinking` block that would hold the text — but a client is entitled to replay
 * an assistant turn verbatim, and Anthropic refuses a `thinking` block whose `signature` this router
 * cannot produce. Synthesizing one would answer this turn and break the next
 * (`06-protocol-translation.md#known-lossy-edges`).
 */

/** Neither field is required: a compatible upstream always names both on its first chunk. */
export interface OpenAiChatToAnthropicStreamOptions {
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

export function openAiChatToAnthropicStream(
  options: OpenAiChatToAnthropicStreamOptions = {},
): StreamTranslator {
  const emitter = createAnthropicStreamEmitter(options)
  const toolCalls = createOpenAiChatToolCallReader()
  let finishReason: string | null = null
  let usage: OpenAiChatUsage | null = null
  let unrecognized: string | null = null

  function terminate(out: SseEvent[]): void {
    // `[DONE]` says the upstream is finished talking, even on the rare broken stream that never sent
    // a `finish_reason` chunk — and real Anthropic never states a `message_delta` with a null
    // `stop_reason`. `toAnthropicStopReason(null)` reads as "not finished yet" mid-stream, which is
    // the wrong claim once termination is unconditional here; the conservative fallback is used
    // directly instead, the same value an unrecognized reason would fall back to.
    const mapped =
      finishReason === null
        ? { value: CONSERVATIVE_STOP_REASON, unrecognized: null }
        : toAnthropicStopReason(finishReason)
    unrecognized = mapped.unrecognized ?? unrecognized
    emitter.terminate(out, { stopReason: mapped.value, usage: anthropicUsageCounts(usage) })
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
      emitter.text(out, choice.delta?.content ?? "")
      for (const call of choice.delta?.tool_calls ?? []) {
        const key = toolCalls.key(call)
        emitter.toolStart(out, key, { id: call.id, name: call.function?.name })
        emitter.toolArgs(out, key, call.function?.arguments ?? "")
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason
        // The block is closed here rather than at termination: a finish reason means no further
        // content, and the client learns the block ended without waiting for the usage chunk.
        emitter.closeBlock(out)
      }
      return out
    },

    flush() {
      // A stream that ended without a finish reason was truncated. Synthesizing `message_delta` and
      // `message_stop` for it would report a completion that never happened.
      if (emitter.isTerminated() || finishReason === null) return NO_EVENTS
      const out: SseEvent[] = []
      terminate(out)
      return out
    },

    unrecognizedStopReason: () => unrecognized,
  }
}
