import type { SseEvent, TranslationContext, TranslationPair } from "../translate"
import { createSseParser, encodeSseEvent } from "../translate"
import { clientHeaders } from "./egress/headers"
import type { RelayObserver } from "./relay"

/**
 * The relay for a translated response — a sibling of `relay.ts`, never a mode inside it.
 *
 * The passthrough relay stays byte-for-byte and schema-free (non-negotiable 10); this one is the
 * only place a response body is ever read, and it is separate so that no future edit to the
 * translation path can accidentally put a parser on the passthrough one.
 *
 * **Incremental, per emitted event.** An upstream chunk is parsed into whole SSE frames, each frame
 * is pushed through the translator, and everything it emitted is written immediately — the router
 * never waits for a complete upstream event before flushing what it already has, and never
 * accumulates content (`docs/idea/06-protocol-translation.md#performance-rules`). A frame split
 * across two TCP reads is carried by the parser, not by a buffer here.
 *
 * **The observer sees the upstream's bytes, and the client's timing.** `onChunk` is handed the
 * bytes the upstream sent, because the `UsageRecord` stores the upstream's own token numbers rather
 * than the translated ones (`#usage-and-token-fields`); `onFirstByte` fires when the first
 * *translated* byte is on its way, because time-to-first-byte is a claim about what the client
 * experienced. Both fire **after** the enqueue, so observation can never sit between a byte and the
 * client, and an observer that throws degrades reporting rather than breaking the stream.
 *
 * A non-streaming body is read whole before it is converted. That is not a violation of the
 * streaming rule: there is no stream — the upstream sent one JSON object and the client is owed one
 * JSON object, and no byte is delayed that could have gone out earlier.
 */

export interface TranslatedRelayInput {
  readonly upstream: Response
  readonly pair: TranslationPair
  readonly context: TranslationContext
  readonly observer?: RelayObserver
  /**
   * A stop reason this build does not define, reported once at the end of the response.
   *
   * A translator is pure and holds no logger, so the value is handed to the caller — which holds
   * the request id — to log. One line per provider change, none in steady state.
   */
  readonly onUnrecognizedStopReason?: (reason: string) => void
}

const EVENT_STREAM = "text/event-stream"

export function relayTranslatedResponse(input: TranslatedRelayInput): Response {
  const { upstream, observer = {} } = input
  const headers = clientHeaders(upstream.headers)
  const init = { status: upstream.status, statusText: upstream.statusText, headers }

  if (upstream.body === null) {
    observer.onEnd?.(0)
    return new Response(null, init)
  }

  const body = upstream.headers.get("content-type")?.includes(EVENT_STREAM)
    ? translatedStream(input, upstream.body)
    : translatedBody(input, upstream.body)

  return new Response(body, init)
}

/** Reporting must never break traffic, and an observer belongs to whoever passed it in. */
function guard(report: () => void): void {
  try {
    report()
  } catch {
    // A broken observer degrades reporting for this request. It does not break the response.
  }
}

function translatedStream(
  input: TranslatedRelayInput,
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const { observer = {} } = input
  const parser = createSseParser()
  const translator = input.pair.stream(input.context)
  const encoder = new TextEncoder()

  let bytes = 0
  let settled = false

  const write = (controller: TransformStreamDefaultController<Uint8Array>, text: string): void => {
    if (text.length === 0) return
    const chunk = encoder.encode(text)
    // Enqueue first. Everything after this line happens on time the client already has.
    controller.enqueue(chunk)
    const first = bytes === 0
    bytes += chunk.length
    if (first) guard(() => observer.onFirstByte?.())
  }

  const settle = (error: unknown): void => {
    if (settled) return
    settled = true
    const unrecognized = translator.unrecognizedStopReason()
    if (unrecognized !== null) guard(() => input.onUnrecognizedStopReason?.(unrecognized))
    if (error === undefined) guard(() => observer.onEnd?.(bytes))
    else guard(() => observer.onError?.(error, bytes))
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      write(controller, render(parser.push(chunk).flatMap((frame) => translator.push(frame))))
      // The upstream's own bytes, so token counting reads the numbers the provider stated.
      guard(() => observer.onChunk?.(chunk))
    },
    flush(controller) {
      // A frame the upstream never terminated is still a frame; the translator decides whether the
      // stream earned a terminator, and emits nothing at all when it was truncated.
      const trailing = parser.flush().flatMap((frame) => translator.push(frame))
      write(controller, render([...trailing, ...translator.flush()]))
      settle(undefined)
    },
  })

  upstream.pipeTo(transform.writable).catch((error: unknown) => {
    settle(error)
  })

  return transform.readable
}

function render(events: readonly SseEvent[]): string {
  let out = ""
  for (const event of events) out += encodeSseEvent(event)
  return out
}

/**
 * The non-streaming path: read the upstream object, convert it, write one body.
 *
 * A body that is not JSON at all is relayed unchanged. The upstream answered with a success status
 * and something we cannot read, and rebuilding that into an empty-but-well-formed completion would
 * report a result nobody produced — the honest answer is the bytes it actually sent.
 */
function translatedBody(
  input: TranslatedRelayInput,
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const { observer = {} } = input

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let raw: Uint8Array
      try {
        raw = await readAll(upstream)
      } catch (error) {
        controller.error(error)
        guard(() => observer.onError?.(error, 0))
        return
      }

      guard(() => observer.onChunk?.(raw))
      const text = new TextDecoder("utf-8").decode(raw)
      const chunk = translate(input, text) ?? raw

      controller.enqueue(chunk)
      controller.close()
      guard(() => observer.onFirstByte?.())
      guard(() => observer.onEnd?.(chunk.length))
    },
  })
}

/** @returns the converted body, or null when the upstream sent something that is not JSON. */
function translate(input: TranslatedRelayInput, text: string): Uint8Array | null {
  let source: unknown
  try {
    source = JSON.parse(text)
  } catch {
    return null
  }
  const translated = input.pair.response(source, input.context)
  const unrecognized = translated.unrecognizedStopReason
  if (unrecognized !== null) guard(() => input.onUnrecognizedStopReason?.(unrecognized))
  return new TextEncoder().encode(JSON.stringify(translated.body))
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      chunks.push(value)
      total += value.length
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}
