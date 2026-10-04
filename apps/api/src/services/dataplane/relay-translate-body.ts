import { collectResponsesStream } from "../translate"
import { TranslationStreamError } from "../translate/shared/stream-error"
import { readRelayBody } from "./relay-body-read"
import { ClientCancelledError, observeCancellation } from "./relay-cancellation"
import type { TranslatedRelayInput } from "./relay-translate"

/**
 * The translated relay's whole-body half: one upstream object in, one client object out. Split from
 * `relay-translate.ts` so the streaming half reads on its own. Both readers below end here — a JSON
 * body, and a Responses stream an upstream was made to send for a client that did not ask for one.
 */

/** Reporting must never break traffic, and an observer belongs to whoever passed it in. */
export function guard(report: () => void): void {
  try {
    report()
  } catch {
    // A broken observer degrades reporting for this request. It does not break the response.
  }
}

const UNREADABLE = Symbol("unreadable")

/** A JSON body, or `UNREADABLE` when the upstream sent something that is not JSON. */
export function parsed(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(raw))
  } catch {
    return UNREADABLE
  }
}

/** A whole Responses SSE stream folded into its final object, or `UNREADABLE` when truncated. */
export function collected(raw: Uint8Array): unknown {
  return collectResponsesStream(raw) ?? UNREADABLE
}

/**
 * The non-streaming path: read the upstream object, convert it, write one body. `read` is
 * {@link parsed} for a JSON upstream, or {@link collected} for a forced Responses stream.
 *
 * A body that is not JSON at all is relayed unchanged. The upstream answered with a success status
 * and something we cannot read, and rebuilding that into an empty-but-well-formed completion would
 * report a result nobody produced — the honest answer is the bytes it actually sent.
 */
export function translatedBody(
  input: TranslatedRelayInput,
  upstream: ReadableStream<Uint8Array>,
  read: (raw: Uint8Array) => unknown,
): ReadableStream<Uint8Array> {
  const { observer = {} } = input
  let settled = false
  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    guard(() => observer.onError?.(error, 0))
  }
  const cancelled = new AbortController()
  const signal =
    input.signal === undefined
      ? cancelled.signal
      : AbortSignal.any([input.signal, cancelled.signal])
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let raw: Uint8Array
      try {
        raw = await readRelayBody(upstream, signal)
      } catch (error) {
        controller.error(error)
        fail(error)
        return
      }

      guard(() => observer.onChunk?.(raw))
      const source = read(raw)
      if (source === UNREADABLE && read === collected) {
        // A forced stream that never reached its final event: there is no answer to convert, and
        // half of one would be a result nobody produced. Fails honestly; nothing was written.
        const error = new TranslationStreamError(
          "translation_protocol_error",
          "upstream stream ended before its final response event",
        )
        controller.error(error)
        fail(error)
        return
      }
      const chunk = source === UNREADABLE ? raw : translate(input, source)

      controller.enqueue(chunk)
      guard(() => observer.onWireBytes?.(chunk.length))
      controller.close()
      guard(() => observer.onFirstByte?.())
      settled = true
      guard(() => observer.onEnd?.(chunk.length))
    },
  })
  return observeCancellation(body, () => {
    const error = new ClientCancelledError()
    fail(error)
    cancelled.abort(error)
  })
}

function translate(input: TranslatedRelayInput, source: unknown): Uint8Array {
  const translated = input.pair.response(source, input.context)
  const unrecognized = translated.unrecognizedStopReason
  if (unrecognized !== null) guard(() => input.onUnrecognizedStopReason?.(unrecognized))
  return new TextEncoder().encode(JSON.stringify(translated.body))
}
