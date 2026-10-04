import type { SseFrame } from "./parse"

/**
 * The emitted half of the SSE seam: the event a translator produces, its encoder, and the contract
 * every stream translator satisfies.
 *
 * Ordinary deltas leave incrementally. Fragments whose target block cannot open yet wait in a
 * configured bounded queue; a final Responses snapshot can recover a verified missing suffix.
 * Local limit or consistency faults remain distinct from upstream HTTP/provider verdicts.
 * Returning events keeps push/flush deterministic and independently testable.
 *
 * Nothing here throws. Once bytes are on the wire the request fails honestly; it is never
 * retranslated and never retried onto another account.
 */

export interface SseEvent {
  /** Rendered as an `event:` line. Anthropic names every event; openai-chat names none. */
  readonly event?: string | undefined
  /** Rendered as the `data:` payload — already-serialized JSON, or the `[DONE]` sentinel. */
  readonly data: string
}

export interface StreamTranslator {
  /** @returns the client events this upstream frame produced, in order. Never throws. */
  push(frame: SseFrame): readonly SseEvent[]
  /**
   * The upstream stream ended. @returns the terminal events the target dialect is still owed, and
   * nothing at all when the stream was truncated — a synthesized clean finish would report a
   * completion that never happened.
   */
  flush(): readonly SseEvent[]
  /**
   * A stop reason this build does not define, or null.
   *
   * A translator is pure and has no logger behind it, so the unrecognized value is **returned** for
   * the caller — which holds the request id — to log. One line per provider change, none in steady
   * state (`06-protocol-translation.md#stop-and-finish-reasons`).
   */
  unrecognizedStopReason(): string | null
  /** A local translation fault remains distinct from the upstream HTTP/transport verdict. */
  translationFailure?(): Error | null
}

export const NO_EVENTS: readonly SseEvent[] = []

/** The openai-chat stream terminator. Anthropic has no equivalent; it ends on `message_stop`. */
export const DONE: SseEvent = { data: "[DONE]" }

export function encodeSseEvent(event: SseEvent): string {
  const name = event.event === undefined ? "" : `event: ${event.event}\n`
  const lines = event.data.split("\n")
  let payload = ""
  for (const line of lines) payload += `data: ${line}\n`
  return `${name}${payload}\n`
}
