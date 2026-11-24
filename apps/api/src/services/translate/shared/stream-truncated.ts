import type { Dialect } from "@multi-ai-router/core"
import { refusalBody } from "../../../errors/render"
import type { RouterVerdict } from "../../../errors/router-object"
import type { SseEvent } from "../sse/emit"
import { NO_EVENTS } from "../sse/emit"

/**
 * What a translated stream owes its client when the upstream ended **cleanly** before stating a
 * terminal event: one router error event in the client's dialect, and nothing else.
 *
 * Never a synthesized finish, `[DONE]` or `message_stop` — that would report a completion that did
 * not happen. Saying nothing was the other half of the same mistake: the stream ended on its last
 * content delta, which most SDKs read as a finished answer. An error event is neither; it is the
 * reason, in the shape the client's SDK already reads as an error, with the `router` object every
 * router-authored error carries (`errors/router-object.ts`).
 *
 * **Exactly one error event per stream.** A *transport* fault after the first byte is
 * `dataplane/relay-stream-end.ts`'s: the upstream read throws, the translated relay errors, and no
 * `flush()` ever runs. This module is reached only from `flush()`, which runs only on a clean EOF,
 * and only for a stream that started, stated no terminal, and emitted no error event of its own —
 * so the two never fire together, and neither fires after an upstream's own in-stream error.
 *
 * Same event shapes as that module, minus the openai-chat `[DONE]`: the transport fault ends a
 * stream the router is tearing down, while this one is the translator's own last word and the
 * sentinel is the one thing it must not manufacture.
 *
 * Pure. The request id is injected (`TranslationContext.fallbackId`), like the clock.
 */

/** The `error_class` the usage row already records for an explicit incomplete; one word for both. */
export const TRUNCATED_STREAM_SIGNAL = "upstream_incomplete"

const MESSAGE = `the upstream stream ended before its final event (${TRUNCATED_STREAM_SIGNAL}); not retried, bytes were already sent`

/** `capacity` is retryable: the same request, sent again, is expected to complete. */
const VERDICT: RouterVerdict = {
  wall: "capacity",
  scope: "account",
  signal: TRUNCATED_STREAM_SIGNAL,
}

export function truncatedStreamEvent(ingress: Dialect, requestId: string | null): SseEvent {
  const body = refusalBody(ingress, 502, MESSAGE, TRUNCATED_STREAM_SIGNAL, VERDICT, requestId)
  if ("type" in body) return { event: "error", data: JSON.stringify(body) }
  if (ingress === "openai-chat") return { data: JSON.stringify(body) }
  // The Responses stream's `error` event is flat: `router` sits beside `code` and `message`.
  const { message, code, router } = body.error
  return {
    event: "error",
    data: JSON.stringify({ type: "error", code, message, param: null, router }),
  }
}

export interface TruncationWatch {
  /** Notes that the client was sent something. @returns `events`, for use in a return position. */
  saw(events: readonly SseEvent[]): readonly SseEvent[]
  /** The error event, once, for a stream that started; nothing for one that never did. */
  end(): readonly SseEvent[]
  /** Whether {@link end} emitted the error event — the caller's cue to record the truncation. */
  truncated(): boolean
}

/** One per stream. The translator calls `end()` only when it reached no terminal of its own. */
export function createTruncationWatch(
  ingress: Dialect,
  requestId: string | undefined,
): TruncationWatch {
  let started = false
  let truncated = false
  return {
    saw(events) {
      if (events.length > 0) started = true
      return events
    },
    end() {
      if (!started || truncated) return NO_EVENTS
      truncated = true
      return [truncatedStreamEvent(ingress, requestId ?? null)]
    },
    truncated: () => truncated,
  }
}
