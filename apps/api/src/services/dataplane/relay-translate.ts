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
 * **An upstream keepalive is forwarded, not swallowed.** A comment line (`: OPENROUTER PROCESSING`,
 * `: keep-alive`) is how a provider holds the connection open through a long time-to-first-token,
 * and it is exactly during that window that a proxy or a client idle timer would otherwise close a
 * socket that was fine. It goes out as a comment of its own — no dialect's client reads one as an
 * event — and it does not count as the first byte: time-to-first-byte is a claim about *content*,
 * and a keepalive is the upstream saying there is none yet.
 *
 * **And this relay emits one of its own, because translation can be silent while the upstream is
 * loud.** A dropped frame is a frame that produced no client event — `thinking` and
 * `redacted_thinking` deltas have no openai-chat counterpart and are documented as dropped
 * (`06-protocol-translation.md`). An extended-thinking model spends its opening minute emitting
 * nothing else, so the *upstream* stream is busy, the *translated* stream writes zero bytes, and
 * the client's connection sits idle through the whole thinking phase. Measured in-cluster,
 * 2026-09-06, one request against one account back to back: `/v1/chat/completions` got 210 bytes and
 * the socket closed under it at 11.9 s, while `/v1/messages` — the byte relay, no translation —
 * carried 20,469 bytes of the same answer and was still streaming at 22 s.
 *
 * That cost whole agent turns, and it read as everything except what it was: the teardown aborts the
 * request, the subprocess dies mid-thinking, and the renderer then reports a turn that ended with a
 * `thinking` block open (`sdk turn ended mid-answer`). The *symptom* was upstream-shaped; the cause
 * was here.
 *
 * So a chunk that produces nothing for the client still keeps the connection alive, if it has been
 * quiet long enough. It is a comment, so it cannot be mistaken for content in any dialect; it does
 * not count as the first byte, for the same reason a forwarded one does not; and it is bounded by a
 * cadence rather than sent per chunk, so a stream that is merely dropping a few frames pays
 * nothing.
 *
 * A non-streaming body is read whole before it is converted. That is not a violation of the
 * streaming rule: there is no stream — the upstream sent one JSON object and the client is owed one
 * JSON object, and no byte is delayed that could have gone out earlier.
 */

/**
 * How long a translated stream may write nothing to the client while the upstream is still sending.
 *
 * The renderer's own SSE keep-alive is 15 s (`claude-sdk/render/idle-guard.ts`) and this is well
 * inside it deliberately: that one measures the *upstream* going quiet, which is a different
 * question from this one, and the two must not be tuned as though they were the same.
 */
export const DEFAULT_TRANSLATED_KEEPALIVE_MS = 5_000

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
  /** {@link DEFAULT_TRANSLATED_KEEPALIVE_MS}. Injected so a test drives it without waiting. */
  readonly keepaliveMs?: number
  /** Injected for the same reason. Defaults to the wall clock; nothing here reads one otherwise. */
  readonly now?: () => number
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
  // Collected per chunk and written ahead of that chunk's frames: a comment carries no data, so its
  // order relative to the frames beside it is immaterial, and nothing is held past the chunk.
  let comments: string[] = []
  const parser = createSseParser({ onComment: (text) => void comments.push(text) })
  const translator = input.pair.stream(input.context)
  const encoder = new TextEncoder()

  let bytes = 0
  let settled = false

  const now = input.now ?? (() => Date.now())
  const keepaliveMs = input.keepaliveMs ?? DEFAULT_TRANSLATED_KEEPALIVE_MS
  /** When the client last had bytes. Seeded at the start, so the first quiet window is measured. */
  let lastWrite = now()

  const keepalive = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (comments.length === 0) return
    let out = ""
    for (const text of comments) out += `:${text}\n\n`
    comments = []
    controller.enqueue(encoder.encode(out))
  }

  const write = (controller: TransformStreamDefaultController<Uint8Array>, text: string): void => {
    if (text.length === 0) return
    const chunk = encoder.encode(text)
    // Enqueue first. Everything after this line happens on time the client already has.
    controller.enqueue(chunk)
    lastWrite = now()
    const first = bytes === 0
    bytes += chunk.length
    if (first) guard(() => observer.onFirstByte?.())
  }

  /**
   * The upstream is sending and the client is getting nothing. Says so, in the one way that cannot
   * be read as content: an SSE comment carries no event and no data, only a byte.
   */
  const heartbeat = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (now() - lastWrite < keepaliveMs) return
    controller.enqueue(encoder.encode(":\n\n"))
    lastWrite = now()
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
      const events = parser.push(chunk).flatMap((frame) => translator.push(frame))
      keepalive(controller)
      const out = render(events)
      // Before the write, so a chunk that *does* produce output resets the clock through `write`
      // rather than sending a comment it did not need.
      if (out.length === 0) heartbeat(controller)
      write(controller, out)
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
