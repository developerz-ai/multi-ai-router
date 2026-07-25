import type { SseEvent } from "../sse/emit"
import { parseUpstreamError } from "./errors"
import type { ResponsesOutputItem, ResponsesStatus } from "./responses-body"
import {
  responsesBodyJson,
  responsesDoneEvents,
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
 * Nothing here throws, and a truncated stream is never given a terminator: the caller simply never
 * calls `complete`.
 */

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
  /** Opens a `function_call` item for `key` if it has none yet. Idempotent. */
  toolStart(
    out: SseEvent[],
    key: string | number,
    call: { readonly id?: string | null; readonly name?: string | null },
  ): void
  toolArgs(out: SseEvent[], key: string | number, partialJson: string): void
  closeItem(out: SseEvent[]): void
  complete(out: SseEvent[], end: ResponsesStreamEnd): void
  fail(out: SseEvent[], payload: unknown): void
}

interface Draft {
  readonly kind: ResponsesOutputItem["type"]
  readonly index: number
  readonly id: string
  readonly key: string | number | null
  text: string
  callId: string
  name: string
}

export function createResponsesStreamEmitter(
  options: ResponsesStreamEmitterOptions,
): ResponsesStreamEmitter {
  let id = options.id ?? ""
  let model = options.model ?? ""
  let started = false
  let terminated = false
  let sequence = 0
  let open: Draft | null = null
  const items: ResponsesOutputItem[] = []
  /** The source's call key → the item index it opened. Never reused, never reset. */
  const toolItems = new Map<string | number, number>()

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

  function finished(draft: Draft): ResponsesOutputItem {
    if (draft.kind === "message") return { type: "message", id: draft.id, text: draft.text }
    if (draft.kind === "reasoning") return { type: "reasoning", id: draft.id, summary: draft.text }
    return {
      type: "function_call",
      id: draft.id,
      call_id: draft.callId,
      name: draft.name,
      arguments: draft.text,
    }
  }

  function openDraft(
    out: SseEvent[],
    kind: ResponsesOutputItem["type"],
    key: string | number | null,
  ): Draft {
    closeItem(out)
    const index = items.length
    const draft: Draft = {
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

  function added(out: SseEvent[], draft: Draft): void {
    out.push(
      event("response.output_item.added", {
        output_index: draft.index,
        item: responsesItemJson(finished(draft), "in_progress"),
      }),
    )
  }

  function closeItem(out: SseEvent[]): void {
    const draft = open
    if (draft === null) return
    open = null
    const item = finished(draft)
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

    text(out, delta) {
      if (delta.length === 0) return
      let draft = open
      if (draft === null || draft.kind !== "message") {
        draft = openDraft(out, "message", null)
        added(out, draft)
        out.push(
          event("response.content_part.added", {
            item_id: draft.id,
            output_index: draft.index,
            content_index: 0,
            part: responsesTextPart(""),
          }),
        )
      }
      draft.text += delta
      out.push(
        event("response.output_text.delta", {
          item_id: draft.id,
          output_index: draft.index,
          content_index: 0,
          delta,
        }),
      )
    },

    reasoning(out, delta) {
      if (delta.length === 0) return
      let draft = open
      if (draft === null || draft.kind !== "reasoning") {
        draft = openDraft(out, "reasoning", null)
        added(out, draft)
        out.push(
          event("response.reasoning_summary_part.added", {
            item_id: draft.id,
            output_index: draft.index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          }),
        )
      }
      draft.text += delta
      out.push(
        event("response.reasoning_summary_text.delta", {
          item_id: draft.id,
          output_index: draft.index,
          summary_index: 0,
          delta,
        }),
      )
    },

    toolStart(out, key, call) {
      if (toolItems.has(key)) return
      const draft = openDraft(out, "function_call", key)
      draft.callId = call.id ?? ""
      draft.name = call.name ?? ""
      toolItems.set(key, draft.index)
      added(out, draft)
    },

    toolArgs(out, key, partialJson) {
      const draft = open
      // Arguments for an item already closed have nowhere to go: its `done` event told the client
      // the call was complete, and reopening it would contradict what it was already told.
      if (draft === null || draft.key !== key || partialJson.length === 0) return
      draft.text += partialJson
      out.push(
        event("response.function_call_arguments.delta", {
          item_id: draft.id,
          output_index: draft.index,
          delta: partialJson,
        }),
      )
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
