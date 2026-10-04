import { renderErrorBody } from "../../../errors/render"
import type { SseEvent } from "../sse/emit"
import { parseUpstreamError } from "./errors"
import { createPendingStreamBlocks } from "./pending-stream-blocks"
import type { ResponsesRecoveryOptions } from "./responses-snapshot-recovery"
import { ROUTER_THINKING_SIGNATURE } from "./router-thinking"
import type { AnthropicStopReason } from "./stop-reason"
import { TranslationStreamError } from "./stream-error"

/** Anthropic output retains one open block. Only interleaved fragments which cannot enter
 * that block wait in a bounded first-sighting queue; live tool arguments leave immediately.
 * A local limit fault is emitted honestly and prevents a later success terminator. */

export interface AnthropicStreamEmitterOptions extends ResponsesRecoveryOptions {
  readonly id?: string | undefined
  readonly model?: string | undefined
}

export interface AnthropicStreamEnd {
  readonly stopReason: AnthropicStopReason | null
  readonly usage: Record<string, number>
}

export interface AnthropicStreamEmitter {
  isTerminated(): boolean
  translationFailure(): Error | null
  identify(id: string | null | undefined, model: string | null | undefined): void
  start(out: SseEvent[]): void
  /** `reasoning` text lands in a router-signed `thinking` block (`router-thinking.ts`). */
  text(out: SseEvent[], text: string, startsNewBlock?: boolean, kind?: FragmentKind): void
  toolStart(
    out: SseEvent[],
    key: string | number,
    call: { readonly id?: string | null; readonly name?: string | null },
  ): void
  toolArgs(out: SseEvent[], key: string | number, partialJson: string): void
  toolDone(out: SseEvent[], key: string | number): void
  closeBlock(out: SseEvent[]): void
  closeTextBlock(out: SseEvent[]): void
  terminate(out: SseEvent[], end: AnthropicStreamEnd): void
  fail(out: SseEvent[], payload: unknown): void
}

type FragmentKind = "message" | "reasoning"
const SIGNED = { type: "signature_delta", signature: ROUTER_THINKING_SIGNATURE }

interface OpenBlock {
  readonly index: number
  readonly tool: string | number | null
  readonly thinking: boolean
}

export function createAnthropicStreamEmitter(
  options: AnthropicStreamEmitterOptions = {},
): AnthropicStreamEmitter {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let started = false
  let terminated = false
  let failure: Error | null = null
  let nextBlock = 0
  let open: OpenBlock | null = null
  const toolBlocks = new Map<string | number, number>()
  const pending = createPendingStreamBlocks(options.maximumPendingBytes)

  function event(type: string, payload: Record<string, unknown>): SseEvent {
    // The `type` is repeated inside the payload because Anthropic states it in both places, and a
    // client reading only the data object is entitled to find it there.
    return { event: type, data: JSON.stringify({ type, ...payload }) }
  }

  function closeOpen(out: SseEvent[]): void {
    if (open === null) return
    if (open.thinking) out.push(event("content_block_delta", { index: open.index, delta: SIGNED }))
    out.push(event("content_block_stop", { index: open.index }))
    open = null
  }

  function openToolBlock(
    out: SseEvent[],
    key: string | number,
    call: { readonly id?: string | null; readonly name?: string | null },
  ): number {
    closeOpen(out)
    const index = nextBlock
    nextBlock += 1
    toolBlocks.set(key, index)
    open = { index, tool: key, thinking: false }
    out.push(
      event("content_block_start", {
        index,
        content_block: { type: "tool_use", id: call.id ?? "", name: call.name ?? "", input: {} },
      }),
    )
    return index
  }

  function closeBlock(out: SseEvent[]): void {
    closeOpen(out)
    // Whatever waited for a block gets one now, in the order the upstream introduced the calls.
    // Their arguments are already whole, so each block opens, states them once, and closes.
    for (const call of pending.drain()) {
      if ("text" in call) {
        emitFragment(out, call.text, call.kind)
        closeOpen(out)
        continue
      }
      const index = openToolBlock(out, call.key, call)
      if (call.args.length > 0)
        out.push(
          event("content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: call.args },
          }),
        )
      closeOpen(out)
    }
  }

  /** Starts the required message envelope once. */
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

  /** Appends to the open block of the same kind, or opens one; `reasoning` is a `thinking` block. */
  function emitFragment(out: SseEvent[], text: string, kind: FragmentKind = "message") {
    if (text.length === 0) return
    const thinking = kind === "reasoning"
    if (open === null || open.tool !== null || open.thinking !== thinking) {
      closeOpen(out)
      open = { index: nextBlock, tool: null, thinking }
      nextBlock += 1
      const content_block = thinking
        ? { type: "thinking", thinking: "", signature: "" }
        : { type: "text", text: "" }
      out.push(event("content_block_start", { index: open.index, content_block }))
    }
    const delta = thinking
      ? { type: "thinking_delta", thinking: text }
      : { type: "text_delta", text }
    out.push(event("content_block_delta", { index: open.index, delta }))
  }

  function toolDone(out: SseEvent[], key: string | number) {
    if (terminated) return
    pending.done(key)
    if (open?.tool !== key) return
    closeOpen(out)
    for (let block = pending.shift(); block !== undefined; block = pending.shift()) {
      if ("text" in block) {
        if (block.startsNewBlock) closeOpen(out)
        emitFragment(out, block.text, block.kind)
        continue
      }
      const index = openToolBlock(out, block.key, block)
      if (block.args.length > 0)
        out.push(
          event("content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: block.args },
          }),
        )
      if (!block.completed) return
      closeOpen(out)
    }
  }

  function overflow(out: SseEvent[]) {
    terminated = true
    failure = new TranslationStreamError(
      "translation_pending_overflow",
      "Translation pending fragments exceed their configured limit",
    )
    out.push({
      event: "error",
      data: JSON.stringify(
        renderErrorBody(
          "anthropic",
          500,
          "Translation pending fragments exceed their configured limit",
          "translation_pending_overflow",
        ),
      ),
    })
  }

  return {
    isTerminated: () => terminated,
    translationFailure: () => failure,

    identify(nextId, nextModel) {
      id = nextId ?? id
      model = nextModel ?? model
    },

    start,

    text(out, text, startsNewBlock = false, kind = "message") {
      if (terminated || text.length === 0) return
      if (open !== null && open.tool !== null) {
        if (!pending.text(text, kind, startsNewBlock)) overflow(out)
        return
      }
      if (startsNewBlock) closeOpen(out)
      emitFragment(out, text, kind)
    },

    /**
     * The block opens on first sight of the call with whatever the upstream has stated so far,
     * rather than waiting for a named function: an upstream that streams arguments without ever
     * naming one is broken, and surfacing an unnamed `tool_use` says so, where dropping the deltas
     * would answer as though the model had never called anything.
     */
    toolStart(out, key, call) {
      if (terminated) return
      if (toolBlocks.has(key)) return
      // A call sighted while another one's block is still open waits for it. Opening this one here
      // would close that one, and every argument it had left to stream would have nowhere to go.
      if (open !== null && open.tool !== null) {
        if (!pending.add(key, { id: call.id, name: call.name })) overflow(out)
        return
      }
      openToolBlock(out, key, call)
    },

    toolArgs(out, key, partialJson) {
      if (terminated) return
      if (partialJson.length === 0) return
      const index = toolBlocks.get(key)
      if (index !== undefined) {
        // A block already closed has nowhere to put these: a stop told the client the call was
        // complete, and Anthropic has no event that reopens one. Only a caller that closes blocks
        // on its own boundaries — the Responses reading, on `output_item.done` — can reach this.
        if (open === null || open.index !== index) return
        out.push(
          event("content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: partialJson },
          }),
        )
        return
      }
      // Held for the block this call has not been given yet, and replayed into it when it opens.
      if (!pending.append(key, partialJson)) overflow(out)
    },

    toolDone,
    closeBlock,
    closeTextBlock(out) {
      if (open?.tool === null) closeOpen(out)
    },

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
