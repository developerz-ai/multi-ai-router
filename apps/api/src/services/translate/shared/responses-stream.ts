import type { SseEvent } from "../sse/emit"
import { parseUpstreamError } from "./errors"
import { createPendingToolCalls } from "./pending-tool-calls"
import type { ResponsesItemDraft, ResponsesOutputItem, ResponsesStatus } from "./responses-body"
import {
  responsesBodyJson,
  responsesDoneEvents,
  responsesDraftItem,
  responsesItemId,
  responsesItemJson,
  responsesTextPart,
} from "./responses-body"
import type { OpenAiResponsesUsage } from "./usage"

/**
 * The openai-responses SSE event sequence, emitted once for every dialect translated into it.
 *
 * Responses streams *items*, not deltas on one message: each piece of output is announced with
 * `response.output_item.added`, filled in by typed deltas, and closed with a matching `done` before
 * the next one opens — the mapping in
 * `docs/idea/06-protocol-translation.md#streaming-sse-event-mapping`, read from the right-hand
 * column. Every payload carries its `type` **inside** the JSON data object as well as on the
 * `event:` line, because a client reading only the data object is entitled to find it there.
 *
 * **This emitter retains the text it has already sent, and that is not buffering.** Every delta
 * leaves the instant it arrives; what is kept is a copy, because the dialect restates the finished
 * text on `response.output_text.done` and the whole response object on `response.completed` — the
 * field a Responses client reads to get its final answer. An empty terminal object would satisfy a
 * sentence about minimal state by breaking every client that uses the SDK's final-response accessor.
 *
 * **A second call sighted while the first item is still open waits rather than displacing it.** One
 * open item at a time is the dialect's shape, not a licence to drop what does not fit: openai-chat
 * may revisit an earlier `tool_calls[].index`, so opening the second call's item on sight would
 * `done` the first while its arguments were still arriving. Such a call is held by
 * `shared/pending-tool-calls.ts` and given an item of its own the moment `closeItem` runs.
 *
 * Nothing here throws, and a truncated stream is never given a terminator: the caller simply never
 * calls `complete`.
 */

/** The two text-shaped items, which differ only in the vocabulary Responses spells them with. */
const TEXT_ITEMS = {
  message: {
    partAdded: "response.content_part.added",
    delta: "response.output_text.delta",
    slot: "content_index",
    emptyPart: responsesTextPart(""),
  },
  reasoning: {
    partAdded: "response.reasoning_summary_part.added",
    delta: "response.reasoning_summary_text.delta",
    slot: "summary_index",
    emptyPart: { type: "summary_text", text: "" },
  },
} as const

export interface ResponsesStreamEmitterOptions {
  /** Unix **seconds**, stamped as `created_at`. Supplied by the caller: a translator holds no clock. */
  readonly created: number
  /** Used until the upstream names an id of its own, and if it never does. */
  readonly id?: string | undefined
  /** Used until the upstream names a model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export interface ResponsesStreamEnd {
  readonly status: "completed" | "incomplete"
  readonly incompleteReason: string | null
  readonly usage: OpenAiResponsesUsage | null
}

export interface ResponsesStreamEmitter {
  isTerminated(): boolean
  identify(id: string | null | undefined, model: string | null | undefined): void
  /** `response.created` + `response.in_progress`, the pair every Responses stream opens with. */
  start(out: SseEvent[]): void
  text(out: SseEvent[], delta: string): void
  reasoning(out: SseEvent[], delta: string): void
  /**
   * Opens a `function_call` item for `key`, or holds the call until the open one closes. Idempotent
   * — a later sighting of a key that already has an item no-ops.
   */
  toolStart(
    out: SseEvent[],
    key: string | number,
    call: { readonly id?: string | null; readonly name?: string | null },
  ): void
  toolArgs(out: SseEvent[], key: string | number, partialJson: string): void
  /** Closes the open item, then gives every held call an item of its own and closes that too. */
  closeItem(out: SseEvent[]): void
  complete(out: SseEvent[], end: ResponsesStreamEnd): void
  fail(out: SseEvent[], payload: unknown): void
}

export function createResponsesStreamEmitter(
  options: ResponsesStreamEmitterOptions,
): ResponsesStreamEmitter {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let started = false
  let terminated = false
  let sequence = 0
  let open: ResponsesItemDraft | null = null
  const items: ResponsesOutputItem[] = []
  /** The source's call key → the item index it opened. Never reused, never reset. */
  const toolItems = new Map<string | number, number>()
  const pending = createPendingToolCalls()

  function event(type: string, payload: Record<string, unknown>): SseEvent {
    const data = JSON.stringify({ type, sequence_number: sequence, ...payload })
    sequence += 1
    return { event: type, data }
  }

  function body(status: ResponsesStatus, end?: ResponsesStreamEnd): Record<string, unknown> {
    return responsesBodyJson({
      id,
      model,
      created: options.created,
      status,
      incompleteReason: end?.incompleteReason ?? null,
      items: status === "in_progress" ? [] : items,
      usage: end?.usage ?? null,
    })
  }

  function openDraft(
    out: SseEvent[],
    kind: ResponsesOutputItem["type"],
    key: string | number | null,
  ): ResponsesItemDraft {
    closeOpen(out)
    const index = items.length
    const draft: ResponsesItemDraft = {
      kind,
      index,
      id: responsesItemId(kind, id, index),
      key,
      text: "",
      callId: "",
      name: "",
    }
    open = draft
    return draft
  }

  function openCall(
    out: SseEvent[],
    key: string | number,
    call: { readonly id?: string | null; readonly name?: string | null },
  ): ResponsesItemDraft {
    const draft = openDraft(out, "function_call", key)
    draft.callId = call.id ?? ""
    draft.name = call.name ?? ""
    toolItems.set(key, draft.index)
    added(out, draft)
    return draft
  }

  function added(out: SseEvent[], draft: ResponsesItemDraft): void {
    out.push(
      event("response.output_item.added", {
        output_index: draft.index,
        item: responsesItemJson(responsesDraftItem(draft), "in_progress"),
      }),
    )
  }

  function callArgs(out: SseEvent[], draft: ResponsesItemDraft, partialJson: string): void {
    draft.text += partialJson
    const anchor = { item_id: draft.id, output_index: draft.index }
    out.push(event("response.function_call_arguments.delta", { ...anchor, delta: partialJson }))
  }

  function streamText(out: SseEvent[], kind: "message" | "reasoning", delta: string): void {
    if (delta.length === 0) return
    const spec = TEXT_ITEMS[kind]
    let draft = open
    if (draft === null || draft.kind !== kind) {
      draft = openDraft(out, kind, null)
      added(out, draft)
      const anchor = { item_id: draft.id, output_index: draft.index, [spec.slot]: 0 }
      out.push(event(spec.partAdded, { ...anchor, part: spec.emptyPart }))
    }
    draft.text += delta
    const anchor = { item_id: draft.id, output_index: draft.index, [spec.slot]: 0 }
    out.push(event(spec.delta, { ...anchor, delta }))
  }

  /**
   * Closes the open item and nothing else. Held calls are deliberately left alone: opening a text
   * item, or the first call's, is not evidence that a *later* call's arguments have all arrived, and
   * flushing one there would `done` a call the upstream was still streaming.
   */
  function closeOpen(out: SseEvent[]): void {
    const draft = open
    if (draft === null) return
    open = null
    const item = responsesDraftItem(draft)
    for (const done of responsesDoneEvents(item, draft.index))
      out.push(event(done.type, done.payload))

    items.push(item)
    out.push(
      event("response.output_item.done", {
        output_index: draft.index,
        item: responsesItemJson(item, "completed"),
      }),
    )
  }

  function closeItem(out: SseEvent[]): void {
    closeOpen(out)
    // Whatever waited for an item gets one now, in the order the upstream introduced the calls.
    // Their arguments are already whole, so each item opens, states them once, and closes.
    for (const call of pending.drain()) {
      const draft = openCall(out, call.key, call)
      if (call.args.length > 0) callArgs(out, draft, call.args)
      closeOpen(out)
    }
  }

  function start(out: SseEvent[]): void {
    if (started) return
    started = true
    out.push(event("response.created", { response: body("in_progress") }))
    out.push(event("response.in_progress", { response: body("in_progress") }))
  }

  return {
    isTerminated: () => terminated,

    identify(nextId, nextModel) {
      id = nextId ?? id
      model = nextModel ?? model
    },

    start,

    text: (out, delta) => streamText(out, "message", delta),

    reasoning: (out, delta) => streamText(out, "reasoning", delta),

    toolStart(out, key, call) {
      if (toolItems.has(key)) return
      // A call sighted while another one's item is still open waits for it. Opening this one here
      // would close that one, and every argument it had left to stream would have nowhere to go.
      if (open !== null && open.kind === "function_call") {
        pending.add(key, { id: call.id, name: call.name })
        return
      }
      openCall(out, key, call)
    },

    toolArgs(out, key, partialJson) {
      if (partialJson.length === 0) return
      const draft = open
      if (draft !== null && draft.key === key) {
        callArgs(out, draft, partialJson)
        return
      }
      // Held for the item this call has not been given yet, and replayed into it when it opens. An
      // item already closed takes nothing: its `done` told the client the call was complete, and
      // reopening it would contradict what it was already told.
      pending.append(key, partialJson)
    },

    closeItem,

    /**
     * `response.incomplete` rather than `response.completed` when the model stopped early — the
     * spec's table names the completed case, and a response that hit its token ceiling is the same
     * fact stated in the field Responses reserves for it.
     */
    complete(out, end) {
      if (terminated) return
      terminated = true
      start(out)
      closeItem(out)
      const type = end.status === "incomplete" ? "response.incomplete" : "response.completed"
      out.push(event(type, { response: body(end.status, end) }))
    },

    fail(out, payload) {
      terminated = true
      const detail = parseUpstreamError(payload, 500)
      const error = { code: detail.code ?? detail.type, message: detail.message }
      out.push(
        event("response.failed", {
          response: { ...body("failed"), error },
        }),
      )
    },
  }
}
