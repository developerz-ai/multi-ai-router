import { z } from "zod"
import { renderErrorBody } from "../../../errors/render"
import { parseUpstreamError } from "../shared/errors"
import { toAnthropicStopReason } from "../shared/stop-reason"
import type { OpenAiChatUsage } from "../shared/usage"
import { parseOpenAiChatUsage, usageToAnthropic } from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * A `chat.completion.chunk` stream → Anthropic SSE events.
 *
 * This is the direction that has to **invent structure**. openai-chat has no block concept: text
 * arrives as `delta.content` and calls as `delta.tool_calls[]` keyed by an index that counts only
 * calls, with no start, no stop, and no ordering between the two. Anthropic's order is the verified
 * one and translating toward it must emit exactly that order
 * (docs/idea/06-protocol-translation.md#streaming-sse-event-mapping):
 *
 * ```
 * message_start → content_block_start → content_block_delta* → content_block_stop
 *               → message_delta (stop_reason + usage.output_tokens) → message_stop
 * ```
 *
 * So this module keeps one open block at a time and closes it the moment the content switches
 * kind — text to a call, one call to the next. Indices are ours: an Anthropic block index counts
 * text blocks too, so it is not the openai call index and the two are mapped, never equated. That
 * the boundaries are reconstructed rather than preserved is a documented loss, not a bug.
 *
 * **The terminal events wait for the end of the stream, and only the terminal events.** openai-chat
 * puts `finish_reason` on one chunk and — with `stream_options.include_usage` — the token counts on
 * a *later* chunk carrying no choices at all, so `message_delta` cannot be emitted the instant a
 * finish reason lands without reporting a completion with no tokens. Content deltas are never held:
 * every one leaves as it arrives.
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

type ParsedToolCall = z.infer<typeof toolCallSchema>

interface OpenBlock {
  readonly index: number
  /** The openai call index this block carries, or null for a text block. */
  readonly tool: number | null
}

export function openAiChatToAnthropicStream(
  options: OpenAiChatToAnthropicStreamOptions = {},
): StreamTranslator {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let started = false
  let terminated = false
  let nextBlock = 0
  let open: OpenBlock | null = null
  /** openai call index → the Anthropic block index it was given. Never reused, never reset. */
  const toolBlocks = new Map<number, number>()
  let finishReason: string | null = null
  let usage: OpenAiChatUsage | null = null
  let unrecognized: string | null = null

  function event(type: string, payload: Record<string, unknown>): SseEvent {
    // The `type` is repeated inside the payload because Anthropic states it in both places, and a
    // client reading only the data object is entitled to find it there.
    return { event: type, data: JSON.stringify({ type, ...payload }) }
  }

  /**
   * `usage` is zeroed here and stated for real on `message_delta`.
   *
   * openai-chat reports its counts last, so nothing is known yet — but the field is required by the
   * shape, and omitting it breaks a strict client on its first event. Anthropic itself puts the
   * authoritative output count on `message_delta`, so the numbers land where a client already looks
   * for them. The `UsageRecord` is unaffected: it stores the upstream's own numbers.
   */
  function start(out: SseEvent[]): void {
    if (started) return
    started = true
    out.push(
      event("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    )
  }

  function closeOpen(out: SseEvent[]): void {
    if (open === null) return
    out.push(event("content_block_stop", { index: open.index }))
    open = null
  }

  function textDelta(out: SseEvent[], text: string): void {
    if (text.length === 0) return
    const current = open
    let index: number
    if (current !== null && current.tool === null) {
      index = current.index
    } else {
      closeOpen(out)
      index = nextBlock
      nextBlock += 1
      open = { index, tool: null }
      out.push(event("content_block_start", { index, content_block: { type: "text", text: "" } }))
    }
    out.push(event("content_block_delta", { index, delta: { type: "text_delta", text } }))
  }

  /**
   * A call's id and name arrive on its first delta and its arguments on the rest.
   *
   * The block is opened on first sight of the index with whatever the upstream stated, rather than
   * waiting for a named call: an upstream that streams arguments without ever naming the function
   * is broken, and surfacing an unnamed `tool_use` says so, where dropping the deltas would answer
   * as though the model had never called anything.
   */
  function toolDelta(out: SseEvent[], call: ParsedToolCall, position: number): void {
    const toolIndex = call.index ?? position
    let index = toolBlocks.get(toolIndex)
    if (index === undefined) {
      closeOpen(out)
      index = nextBlock
      nextBlock += 1
      toolBlocks.set(toolIndex, index)
      open = { index, tool: toolIndex }
      out.push(
        event("content_block_start", {
          index,
          content_block: {
            type: "tool_use",
            id: call.id ?? "",
            name: call.function?.name ?? "",
            input: {},
          },
        }),
      )
    }

    const args = call.function?.arguments ?? ""
    // Arguments for a block that has already been closed have nowhere to go: Anthropic holds one
    // open block at a time, and a stop already told the client this call was complete.
    if (args.length === 0 || open === null || open.index !== index) return
    out.push(
      event("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: args },
      }),
    )
  }

  function terminalUsage(): Record<string, number> {
    const mapped = usage === null ? null : usageToAnthropic(usage)
    // `output_tokens` is required by the shape; the rest are stated only when the upstream counted.
    const counts: Record<string, number> = { output_tokens: mapped?.output_tokens ?? 0 }
    const input = mapped?.input_tokens ?? null
    if (input !== null) counts.input_tokens = input
    const cached = mapped?.cache_read_input_tokens ?? null
    if (cached !== null) counts.cache_read_input_tokens = cached
    return counts
  }

  function terminate(out: SseEvent[]): void {
    if (terminated) return
    terminated = true
    start(out)
    closeOpen(out)
    const mapped = toAnthropicStopReason(finishReason)
    unrecognized = mapped.unrecognized ?? unrecognized
    out.push(
      event("message_delta", {
        delta: { stop_reason: mapped.value, stop_sequence: null },
        usage: terminalUsage(),
      }),
    )
    out.push(event("message_stop", {}))
  }

  /** An upstream error mid-stream. Anthropic spells it as its own event, and the stream is over. */
  function onError(out: SseEvent[], payload: unknown): void {
    terminated = true
    const detail = parseUpstreamError(payload, 500)
    const body = renderErrorBody("anthropic", 500, detail.message, detail.code ?? detail.type)
    out.push({ event: "error", data: JSON.stringify(body) })
  }

  return {
    push(frame) {
      if (terminated) return NO_EVENTS
      const out: SseEvent[] = []
      if (frame.data === DONE_SENTINEL) {
        terminate(out)
        return out
      }

      const payload = frameJson(frame)
      if (payload === null || typeof payload !== "object") return NO_EVENTS
      if ("error" in payload) {
        onError(out, payload)
        return out
      }

      const parsed = chunkSchema.safeParse(payload)
      if (!parsed.success) return NO_EVENTS
      id = parsed.data.id ?? id
      model = parsed.data.model ?? model
      usage = parseOpenAiChatUsage(parsed.data.usage) ?? usage

      // `n > 1` is refused at request time, so the one choice a translated stream can carry is the
      // first; an upstream that answers with more anyway has its extras dropped, not interleaved.
      const choice = (parsed.data.choices ?? []).find((entry) => (entry.index ?? 0) === 0)
      if (choice === undefined) return out

      start(out)
      textDelta(out, choice.delta?.content ?? "")
      for (const [position, call] of (choice.delta?.tool_calls ?? []).entries()) {
        toolDelta(out, call, position)
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason
        // The block is closed here rather than at termination: a finish reason means no further
        // content, and the client learns the block ended without waiting for the usage chunk.
        closeOpen(out)
      }
      return out
    },

    flush() {
      // A stream that ended without a finish reason was truncated. Synthesizing `message_delta` and
      // `message_stop` for it would report a completion that never happened.
      if (terminated || finishReason === null) return NO_EVENTS
      const out: SseEvent[] = []
      terminate(out)
      return out
    },

    unrecognizedStopReason: () => unrecognized,
  }
}
