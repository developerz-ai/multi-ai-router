import { renderErrorBody } from "../../../errors/render"
import type { SseEvent } from "../sse/emit"
import { parseUpstreamError } from "./errors"
import type { AnthropicStopReason } from "./stop-reason"

/**
 * The Anthropic SSE event sequence, emitted once for every dialect that has to be translated into
 * it.
 *
 * The Anthropic order is the **verified** one and translating toward Anthropic must emit exactly it
 * (docs/idea/06-protocol-translation.md#streaming-sse-event-mapping):
 *
 * ```
 * message_start → content_block_start → content_block_delta* → content_block_stop
 *               → message_delta (stop_reason + usage.output_tokens) → message_stop
 * ```
 *
 * No OpenAI dialect has a block concept: openai-chat streams text as `delta.content` and calls as
 * `delta.tool_calls[]`, openai-responses streams them as items and content parts with indices of its
 * own. Neither carries Anthropic's block boundaries, so this module **invents** them — one open
 * block at a time, closed the moment the content switches kind, with indices that are ours and are
 * mapped to the source's numbering rather than equated with it. That the boundaries are
 * reconstructed rather than preserved is a documented loss, not a bug.
 *
 * It is shared rather than written per source dialect because the sequence is a fact about
 * Anthropic: two copies could emit two different orders, and a client would see which ingress path
 * served it — which is exactly what a translator exists to hide. What varies per source is *when*
 * each call happens and how the finish reason and token counts were read, and that stays with the
 * caller.
 *
 * Nothing here throws. Once bytes are on the wire the request fails honestly.
 */

export interface AnthropicStreamEmitterOptions {
  /** Used until the upstream names an id of its own, and if it never does. */
  readonly id?: string | undefined
  /** Used until the upstream names a model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export interface AnthropicStreamEnd {
  readonly stopReason: AnthropicStopReason | null
  /** Already mapped by `shared/usage.ts`: a count nobody measured is absent, never zero. */
  readonly usage: Record<string, number>
}

export interface AnthropicStreamEmitter {
  isTerminated(): boolean
  /** Ids and model names pass through verbatim so one stream is traceable across the seam. */
  identify(id: string | null | undefined, model: string | null | undefined): void
  start(out: SseEvent[]): void
  text(out: SseEvent[], text: string): void
  /** Opens a `tool_use` block for `key` if it has none yet. Idempotent — later sightings no-op. */
  toolStart(
    out: SseEvent[],
    key: string | number,
    call: { readonly id?: string | null; readonly name?: string | null },
  ): void
  toolArgs(out: SseEvent[], key: string | number, partialJson: string): void
  closeBlock(out: SseEvent[]): void
  terminate(out: SseEvent[], end: AnthropicStreamEnd): void
  /** An upstream error mid-stream. Anthropic spells it as its own event, and the stream is over. */
  fail(out: SseEvent[], payload: unknown): void
}

interface OpenBlock {
  readonly index: number
  /** The source's own key for the call this block carries, or null for a text block. */
  readonly tool: string | number | null
}

export function createAnthropicStreamEmitter(
  options: AnthropicStreamEmitterOptions = {},
): AnthropicStreamEmitter {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let started = false
  let terminated = false
  let nextBlock = 0
  let open: OpenBlock | null = null
  /** The source's call key → the Anthropic block index it was given. Never reused, never reset. */
  const toolBlocks = new Map<string | number, number>()

  function event(type: string, payload: Record<string, unknown>): SseEvent {
    // The `type` is repeated inside the payload because Anthropic states it in both places, and a
    // client reading only the data object is entitled to find it there.
    return { event: type, data: JSON.stringify({ type, ...payload }) }
  }

  function closeBlock(out: SseEvent[]): void {
    if (open === null) return
    out.push(event("content_block_stop", { index: open.index }))
    open = null
  }

  /**
   * `usage` is zeroed here and stated for real on `message_delta`.
   *
   * Every OpenAI dialect reports its counts last, so nothing is known yet — but the field is
   * required by the shape, and omitting it breaks a strict client on its first event. Anthropic
   * itself puts the authoritative output count on `message_delta`, so the numbers land where a
   * client already looks for them. The `UsageRecord` is unaffected: it stores the upstream's own
   * numbers (`06-protocol-translation.md#usage-and-token-fields`).
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

  return {
    isTerminated: () => terminated,

    identify(nextId, nextModel) {
      id = nextId ?? id
      model = nextModel ?? model
    },

    start,

    text(out, text) {
      if (text.length === 0) return
      const current = open
      let index: number
      if (current !== null && current.tool === null) {
        index = current.index
      } else {
        closeBlock(out)
        index = nextBlock
        nextBlock += 1
        open = { index, tool: null }
        out.push(event("content_block_start", { index, content_block: { type: "text", text: "" } }))
      }
      out.push(event("content_block_delta", { index, delta: { type: "text_delta", text } }))
    },

    /**
     * The block opens on first sight of the call with whatever the upstream has stated so far,
     * rather than waiting for a named function: an upstream that streams arguments without ever
     * naming one is broken, and surfacing an unnamed `tool_use` says so, where dropping the deltas
     * would answer as though the model had never called anything.
     */
    toolStart(out, key, call) {
      if (toolBlocks.has(key)) return
      closeBlock(out)
      const index = nextBlock
      nextBlock += 1
      toolBlocks.set(key, index)
      open = { index, tool: key }
      out.push(
        event("content_block_start", {
          index,
          content_block: {
            type: "tool_use",
            id: call.id ?? "",
            name: call.name ?? "",
            input: {},
          },
        }),
      )
    },

    toolArgs(out, key, partialJson) {
      const index = toolBlocks.get(key)
      // Arguments for a block that has already been closed have nowhere to go: Anthropic holds one
      // open block at a time, and a stop already told the client this call was complete.
      if (index === undefined || partialJson.length === 0) return
      if (open === null || open.index !== index) return
      out.push(
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: partialJson },
        }),
      )
    },

    closeBlock,

    terminate(out, end) {
      if (terminated) return
      terminated = true
      start(out)
      closeBlock(out)
      out.push(
        event("message_delta", {
          delta: { stop_reason: end.stopReason, stop_sequence: null },
          usage: end.usage,
        }),
      )
      out.push(event("message_stop", {}))
    },

    fail(out, payload) {
      terminated = true
      const detail = parseUpstreamError(payload, 500)
      const body = renderErrorBody("anthropic", 500, detail.message, detail.code ?? detail.type)
      out.push({ event: "error", data: JSON.stringify(body) })
    },
  }
}
