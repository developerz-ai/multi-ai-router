import { renderErrorBody } from "../../../errors/render"
import { parseUpstreamError } from "../shared/errors"
import type { ParsedResponsesEvent } from "../shared/responses-read"
import { responsesEventSchema } from "../shared/responses-read"
import type { OpenAiFinishReason } from "../shared/stop-reason"
import { fromResponsesCompletion } from "../shared/stop-reason"
import { parseOpenAiResponsesUsage, responsesUsageToOpenAiChat } from "../shared/usage"
import type { SseEvent, StreamTranslator } from "../sse/emit"
import { DONE, NO_EVENTS } from "../sse/emit"
import { frameJson } from "../sse/parse"

/**
 * An openai-responses SSE stream → `chat.completion.chunk` events. The **downgrade** direction of
 * the matrix (docs/idea/06-protocol-translation.md#translation-matrix, legend), event by event.
 *
 * Responses streams *items*: each piece of output is announced with `response.output_item.added`,
 * filled in by typed deltas, and closed with a matching `.done` before the next one opens. openai-chat
 * has no item concept at all, so most of that structure is **implied** and emits nothing — the
 * `.added` / `.done` mirrors of a delta already forwarded are dropped, and a text delta simply
 * becomes `delta.content`. Every mapping here is a row of the table at
 * `06-protocol-translation.md#streaming-sse-event-mapping`, read from its right-hand column.
 *
 * Function calls are the exception, because their `added` event carries the id and name that
 * openai-chat puts on the first `delta.tool_calls[]` entry. The `index` on that entry is a **call
 * ordinal this module assigns**, not the Responses `output_index`: Responses numbers items — text,
 * reasoning, and calls alike — while openai-chat's `index` counts only calls, so passing the item
 * number through would leave gaps a client reads as calls it never received.
 *
 * No `event:` line is emitted. openai-chat names no events; every payload is a bare `data:` JSON
 * object, and its terminator is the `[DONE]` sentinel.
 *
 * Dropped, as documented: `response.reasoning_summary_text.delta` — openai-chat has no
 * reasoning-summary field, the same row as an Anthropic `thinking_delta`.
 */

/** `created` is a caller-supplied value, never `Date.now()`: a translator holds no clock. */
export interface OpenAiResponsesToOpenAiChatStreamOptions {
  /** Unix **seconds**, stamped on every chunk. */
  readonly created: number
  /** Used until `response.created` names the upstream's own id, and if it never does. */
  readonly id?: string | undefined
  /** Used until `response.created` names the model. The client's requested name is the right value. */
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

export function openAiResponsesToOpenAiChatStream(
  options: OpenAiResponsesToOpenAiChatStreamOptions,
): StreamTranslator {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let unrecognized: string | null = null
  let nextToolCall = 0
  let finished = false
  let closed = false
  /** Responses item key — its `item.id`, or the `output_index` — → the openai call ordinal. */
  const toolCalls = new Map<string | number, number>()

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

  function onCreated(event: ParsedResponsesEvent | null): readonly SseEvent[] {
    // Ids pass through verbatim so one stream is traceable across the seam; a minted id would make
    // the router's own view and the client's view of the same completion disagree.
    id = event?.response?.id ?? id
    model = event?.response?.model ?? model
    return [chunk({ role: "assistant", content: "" }, null)]
  }

  function onItemAdded(event: ParsedResponsesEvent | null): readonly SseEvent[] {
    const item = event?.item ?? null
    // A `message` or `reasoning` item opens nothing here: its deltas carry everything openai-chat
    // has a field for, and the item boundary itself has no counterpart.
    if (item === null || item.type !== "function_call") return NO_EVENTS

    const ordinal = nextToolCall
    nextToolCall += 1
    const key = item.id ?? event?.output_index ?? null
    if (key !== null) toolCalls.set(key, ordinal)

    const call: ToolCallDelta = {
      index: ordinal,
      // `call_id` is what the client's tool result will be keyed by; the item id is the fallback the
      // non-streaming half of this pair uses too, so both report the same call.
      id: item.call_id ?? item.id ?? "",
      type: "function",
      function: { name: item.name ?? "", arguments: "" },
    }
    return [chunk({ tool_calls: [call] }, null)]
  }

  function onTextDelta(event: ParsedResponsesEvent | null): readonly SseEvent[] {
    const delta = event?.delta ?? ""
    return delta.length === 0 ? NO_EVENTS : [chunk({ content: delta }, null)]
  }

  function onArgumentsDelta(event: ParsedResponsesEvent | null): readonly SseEvent[] {
    const key = event?.item_id ?? event?.output_index ?? null
    const ordinal = key === null ? undefined : toolCalls.get(key)
    // Arguments for an item this module never saw opened have no ordinal to travel under, and
    // inventing one would attach them to a different call. Dropped.
    if (ordinal === undefined) return NO_EVENTS

    const delta = event?.delta ?? ""
    if (delta.length === 0) return NO_EVENTS
    return [chunk({ tool_calls: [{ index: ordinal, function: { arguments: delta } }] }, null)]
  }

  /**
   * The terminal chunk, the usage chunk when the upstream counted, and the sentinel.
   *
   * `response.completed` is both the finish reason and the end of the stream — the spec's table maps
   * it onto the final chunk *and* `data: [DONE]` — so all three leave together.
   *
   * Usage is always emitted toward openai-chat even though an OpenAI stream omits it unless
   * `stream_options.include_usage` was set: the numbers exist, and withholding them would make a
   * translated stream less informative than the one it translates. A count the upstream never sent
   * is absent, never zero (`06-protocol-translation.md#usage-and-token-fields`).
   */
  function onCompleted(
    event: ParsedResponsesEvent | null,
    fallbackStatus: "completed" | "incomplete",
  ): readonly SseEvent[] {
    finished = true
    closed = true

    const response = event?.response ?? null
    // The ordinals handed out above are this module's record of whether a tool call happened, which
    // is the only way Responses states `tool_calls`: by having emitted an item, never by a reason.
    const mapped = fromResponsesCompletion(
      response?.status ?? fallbackStatus,
      response?.incomplete_details?.reason,
      nextToolCall > 0,
    )
    unrecognized = mapped.unrecognized ?? unrecognized

    const events: SseEvent[] = [chunk({}, mapped.value)]
    const usage = parseOpenAiResponsesUsage(response?.usage)
    if (usage !== null) {
      events.push({
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: options.created,
          model,
          choices: [],
          usage: responsesUsageToOpenAiChat(usage),
        }),
      })
    }
    events.push(DONE)
    return events
  }

  /** An upstream error mid-stream: an error chunk, then the stream closes without a `[DONE]`. */
  function onFailed(event: ParsedResponsesEvent | null, payload: unknown): readonly SseEvent[] {
    closed = true
    // `response.failed` carries the detail under `response.error`; a bare `error` event *is* the
    // detail. The whole payload is the fallback, so an unfamiliar shape still says something.
    const detail = parseUpstreamError(event?.response?.error ?? payload, 500)
    const body = renderErrorBody("openai-chat", 500, detail.message, detail.code ?? detail.type)
    return [{ data: JSON.stringify(body) }]
  }

  return {
    push(frame) {
      if (closed) return NO_EVENTS
      const payload = frameJson(frame)
      const parsed = responsesEventSchema.safeParse(payload)
      const event = parsed.success ? parsed.data : null

      // The `type` inside the data object is authoritative; the `event:` line is the fallback for an
      // upstream that names its events only there.
      switch (event?.type ?? frame.event) {
        case "response.created":
          return onCreated(event)
        case "response.output_item.added":
          return onItemAdded(event)
        case "response.output_text.delta":
          return onTextDelta(event)
        case "response.function_call_arguments.delta":
          return onArgumentsDelta(event)
        case "response.completed":
          return onCompleted(event, "completed")
        case "response.incomplete":
          return onCompleted(event, "incomplete")
        case "response.failed":
        case "error":
          return onFailed(event, payload)
        default:
          // `response.in_progress`, the `content_part` / `output_item` / `.done` mirrors of deltas
          // already forwarded, `response.reasoning_summary_text.delta` — no openai-chat counterpart,
          // the same row as an Anthropic `thinking_delta` — and anything OpenAI adds later.
          return NO_EVENTS
      }
    },

    flush() {
      // A truncated stream is never given a synthesized ending: a manufactured terminator would
      // report a completion that did not happen. The reverse is owed — a stated completion normally
      // takes the sentinel out with it, and this is the only path left if it ever did not.
      if (closed || !finished) return NO_EVENTS
      closed = true
      return [DONE]
    },

    unrecognizedStopReason: () => unrecognized,
  }
}
