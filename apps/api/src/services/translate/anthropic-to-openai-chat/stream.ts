import { z } from "zod"
import { renderErrorBody } from "../../../errors/render"
import { parseUpstreamError } from "../shared/errors"
import type { OpenAiFinishReason } from "../shared/stop-reason"
import { CONSERVATIVE_FINISH_REASON, toOpenAiFinishReason } from "../shared/stop-reason"
import type { AnthropicUsage } from "../shared/usage"
import { parseAnthropicUsage, usageToOpenAiChat } from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { DONE, NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * An Anthropic SSE stream → `chat.completion.chunk` events.
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
 * translator that waits for them on `message_stop` emits a finish with no reason and no token
 * count, which is the single most likely way to get this direction wrong.
 *
 * openai-chat has no block concept, so `content_block_start` / `content_block_stop` for text are
 * *implied* and emit nothing: a text delta simply becomes `delta.content`. Tool blocks are the
 * exception — their `start` carries the id and name that openai-chat puts on the first
 * `delta.tool_calls[]` entry, keyed by a call ordinal this module assigns, because Anthropic's
 * block index counts text blocks too and openai's `index` counts only calls.
 *
 * Dropped, as documented: `thinking` / `redacted_thinking` deltas (no counterpart) and `ping`.
 *
 * **A terminal chunk always states a finish reason, and an error always terminates the stream.**
 * Those two are one rule read from both ends, and both were wrong in a way that hung a client
 * rather than failing it (2026-09-06, opencode's `Failed to read … stream` on a long agent turn):
 *
 * - `finish_reason: null` means *different things* in the two dialects. Anthropic's `stop_reason`
 *   is legitimately null when nothing stated one — the Agent-SDK renderer emits exactly that for a
 *   turn whose stream ended mid-block (`claude-sdk/render/envelope.ts`, `finish`) — but openai-chat
 *   has no null finish: a chunk carrying one says "more is coming". Passing the absence through on
 *   the **terminal** chunk therefore ends a stream in which nothing ever finished, and a reader
 *   waiting for a finish reason is right to complain. So the mapping stays honest and unchanged
 *   ({@link toOpenAiFinishReason}); the terminal chunk falls back to
 *   {@link CONSERVATIVE_FINISH_REASON}, whose own doc calls it "the one claim that is safe to make
 *   blind".
 * - An upstream `error` mid-stream used to emit the error object and stop dead — no terminal chunk,
 *   no `[DONE]`, nothing. The client's reader hit EOF still expecting the stream to continue and
 *   threw a parse failure instead of surfacing the error it had just been handed. The error goes
 *   out first, so nothing can mask it, and the stream is then closed properly behind it.
 *
 * **A stream truncated at the transport still gets nothing** — see {@link StreamTranslator.flush}.
 * That case is different in kind: the upstream never said the message was over, so a synthesized
 * terminator would report a completion that did not happen. Here the upstream *did* end the
 * message; it only failed to name why, or named a failure. Both are stories with an ending.
 */

/** `created` is a caller-supplied value, never `Date.now()`: a translator holds no clock. */
export interface AnthropicToOpenAiChatStreamOptions {
  /** Unix **seconds**, stamped on every chunk. */
  readonly created: number
  /** Used until `message_start` names the upstream's own id, and if it never does. */
  readonly id?: string | undefined
  /** Used until `message_start` names the model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

interface ToolCallDelta {
  readonly index: number
  readonly id?: string | undefined
  readonly type?: "function" | undefined
  readonly function: { readonly name?: string | undefined; readonly arguments?: string | undefined }
}

interface ChunkDelta {
  readonly role?: "assistant"
  readonly content?: string
  readonly tool_calls?: readonly ToolCallDelta[]
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
    partial_json: z.string().nullish().catch(null),
  }),
})

const messageDeltaSchema = z.looseObject({
  delta: z.looseObject({ stop_reason: z.string().nullish().catch(null) }).nullish(),
  usage: z.unknown().optional(),
})

export function anthropicToOpenAiChatStream(
  options: AnthropicToOpenAiChatStreamOptions,
): StreamTranslator {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let startUsage: AnthropicUsage | null = null
  let unrecognized: string | null = null
  let nextToolCall = 0
  let finished = false
  let closed = false
  /** Anthropic block index → openai call ordinal, for the blocks whose deltas have somewhere to go. */
  const toolCalls = new Map<number, number>()

  function chunk(delta: ChunkDelta, finishReason: OpenAiFinishReason | null): SseEvent {
    return {
      data: JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: options.created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }),
    }
  }

  function onMessageStart(payload: unknown): readonly SseEvent[] {
    const parsed = messageStartSchema.safeParse(payload)
    const message = parsed.success ? parsed.data.message : null
    // Ids pass through verbatim so one stream is traceable across the seam; a minted id would make
    // the router's own view and the client's view of the same completion disagree.
    id = message?.id ?? id
    model = message?.model ?? model
    startUsage = parseAnthropicUsage(message?.usage)
    return [chunk({ role: "assistant", content: "" }, null)]
  }

  function onBlockStart(payload: unknown): readonly SseEvent[] {
    const parsed = blockStartSchema.safeParse(payload)
    if (!parsed.success) return NO_EVENTS
    const { index, content_block: block } = parsed.data

    if (block.type === "tool_use") {
      const ordinal = nextToolCall
      nextToolCall += 1
      toolCalls.set(index, ordinal)
      const call: ToolCallDelta = {
        index: ordinal,
        id: block.id ?? "",
        type: "function",
        function: { name: block.name ?? "", arguments: "" },
      }
      return [chunk({ tool_calls: [call] }, null)]
    }

    // A text block's `start` is implied on the openai side, but it may already carry text; a
    // `thinking` block, or anything a future model adds, has no counterpart and emits nothing.
    const text = block.type === "text" ? (block.text ?? "") : ""
    return text.length === 0 ? NO_EVENTS : [chunk({ content: text }, null)]
  }

  function onBlockDelta(payload: unknown): readonly SseEvent[] {
    const parsed = blockDeltaSchema.safeParse(payload)
    if (!parsed.success) return NO_EVENTS
    const { index, delta } = parsed.data

    if (delta.type === "text_delta") {
      const text = delta.text ?? ""
      return text.length === 0 ? NO_EVENTS : [chunk({ content: text }, null)]
    }
    if (delta.type !== "input_json_delta") return NO_EVENTS

    const ordinal = toolCalls.get(index)
    if (ordinal === undefined) return NO_EVENTS
    const call: ToolCallDelta = {
      index: ordinal,
      function: { arguments: delta.partial_json ?? "" },
    }
    return [chunk({ tool_calls: [call] }, null)]
  }

  /**
   * The terminal chunk, plus a usage chunk when the upstream counted.
   *
   * Usage is always emitted toward openai-chat even though an OpenAI stream omits it unless
   * `stream_options.include_usage` was set — the numbers exist, and withholding them would make a
   * translated stream less informative than the one it translates. A count the upstream never sent
   * is null, never zero (`06-protocol-translation.md#usage-and-token-fields`).
   */
  function onMessageDelta(payload: unknown): readonly SseEvent[] {
    const parsed = messageDeltaSchema.safeParse(payload)
    if (!parsed.success) return NO_EVENTS
    finished = true

    const mapped = toOpenAiFinishReason(parsed.data.delta?.stop_reason)
    unrecognized = mapped.unrecognized ?? unrecognized
    // This chunk *is* the last one, so an absent reason cannot travel as absence: see the module
    // note. The upstream ended the message without naming why — a turn whose stream stopped
    // mid-block is the common shape — and "the model stopped talking" is the safe blind claim.
    const events: SseEvent[] = [chunk({}, mapped.value ?? CONSERVATIVE_FINISH_REASON)]

    const usage = mergeUsage(startUsage, parseAnthropicUsage(parsed.data.usage))
    if (usage !== null) {
      events.push({
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: options.created,
          model,
          choices: [],
          usage: usageToOpenAiChat(usage),
        }),
      })
    }
    return events
  }

  /**
   * An upstream error mid-stream: the error, then a proper close.
   *
   * The order is the point. The error goes first so a client that surfaces errors sees why the
   * answer stopped, and nothing that follows can mask it. Then the stream is terminated the way
   * every other ending is — a terminal chunk if none has gone out, and `[DONE]` — because a reader
   * that has been handed an error still has to be able to *finish reading*. Emitting the error and
   * stopping dead left it waiting at EOF, which surfaced as a parse failure with the real cause
   * nowhere in sight.
   */
  function onError(payload: unknown): readonly SseEvent[] {
    const detail = parseUpstreamError(payload, 500)
    const body = renderErrorBody("openai-chat", 500, detail.message, detail.code ?? detail.type)
    const events: SseEvent[] = [{ data: JSON.stringify(body) }]
    // Only when the completion had not already stated its own ending: a `message_delta` that
    // arrived before the error is the upstream's own finish, and restating it would be a second
    // terminal chunk in one stream.
    if (!finished) events.push(chunk({}, CONSERVATIVE_FINISH_REASON))
    events.push(DONE)
    closed = true
    finished = true
    return events
  }

  return {
    push(frame) {
      if (closed) return NO_EVENTS
      const payload = frameJson(frame)
      const type = eventType(frame.event, payload)

      switch (type) {
        case "message_start":
          return onMessageStart(payload)
        case "content_block_start":
          return onBlockStart(payload)
        case "content_block_delta":
          return onBlockDelta(payload)
        case "content_block_stop":
          return NO_EVENTS
        case "message_delta":
          return onMessageDelta(payload)
        case "message_stop":
          closed = true
          return [DONE]
        case "error":
          return onError(payload)
        default:
          // `ping`, and anything Anthropic adds after this was written.
          return NO_EVENTS
      }
    },

    flush() {
      if (closed || !finished) return NO_EVENTS
      // `message_delta` arrived and `message_stop` did not. The completion is whole and only its
      // terminator is missing, so the sentinel is owed. A stream that never finished gets nothing.
      closed = true
      return [DONE]
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
