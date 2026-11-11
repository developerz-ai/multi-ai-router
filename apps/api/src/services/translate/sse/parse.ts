import { TranslationStreamError } from "../shared/stream-error"

/**
 * The router's only SSE reader.
 *
 * It exists for exactly one job: turning upstream bytes into whole events on the **translation**
 * path, where a body has to be rebuilt field by field. The passthrough path never reaches here —
 * same-dialect bytes are relayed untouched and are never parsed at all
 * (docs/idea/06-protocol-translation.md#performance-rules).
 *
 * Incremental by construction. A chunk is not an event: a provider is free to split
 * `data: {"type":"content_bl` from `ock_delta",…}` across two TCP reads, and to end a chunk on the
 * `\r` of a `\r\n`. Both are carried across the boundary here so that no caller ever waits for a
 * "complete" chunk. A frame is returned the instant its terminating blank line arrives and not one
 * byte later.
 *
 * The grammar is the WHATWG one: `\r\n` / `\n` / `\r` all end a line, a leading `:` is a comment
 * (which is how every provider spells its keepalive), one leading space after the field colon is
 * stripped, and repeated `data:` lines join with `\n`. `id:` and `retry:` are recognized and
 * ignored — they exist for browser reconnection, which has no meaning for a one-shot completion
 * being proxied, and neither dialect sets them.
 *
 * A comment is never a frame, but it is not nothing either: it is the upstream keeping the
 * connection alive through a long time-to-first-token, and a relay that swallows it hands its
 * client a silent socket for exactly the window the upstream was trying to cover. So the parser
 * hands each one to `onComment` as it arrives, and the translated relay forwards it as a comment
 * of its own (`dataplane/relay-translate.ts`). The passthrough relay never parses and forwards
 * them with everything else.
 *
 * Nothing here throws on stream content. A malformed frame is a stream already on the wire, and by then the request
 * fails honestly rather than being retranslated (`06-protocol-translation.md`, "Rejected: nothing
 * at stream time").
 */

export interface SseFrame {
  /** The `event:` field, or null when the frame carried none — openai-chat never sets one. */
  readonly event: string | null
  /** The `data:` payload; multi-line values are joined with `\n`, as the grammar specifies. */
  readonly data: string
}

export interface SseParser {
  /** @returns every frame this chunk completed, in arrival order. */
  push(chunk: Uint8Array | string): readonly SseFrame[]
  /** The upstream stream ended. @returns a trailing frame the upstream never terminated. */
  flush(): readonly SseFrame[]
  /**
   * Set once a frame outgrew {@link SseParserOptions.maximumFrameLength}; from then on `push` and
   * `flush` return nothing and the caller ends the stream with this error.
   */
  failure(): TranslationStreamError | null
}

const CR = 13
const LF = 10
const BOM = "\uFEFF"
const NONE: readonly SseFrame[] = []

export interface SseParserOptions {
  /** Called with each comment line's text (the part after the leading `:`), in arrival order. */
  readonly onComment?: (text: string) => void
  /**
   * The most UTF-16 code units one frame may hold before it is dispatched: its unterminated line
   * plus the `data:` lines already gathered. Absent means unbounded. An upstream that streams bytes
   * with no line or frame end would otherwise grow one string per stream until it stops.
   */
  readonly maximumFrameLength?: number | undefined
}

export function createSseParser(options: SseParserOptions = {}): SseParser {
  const limit = frameLimit(options.maximumFrameLength)
  const decoder = new TextDecoder("utf-8")
  // The unterminated line, held as the chunks it arrived in and joined once when its end arrives:
  // re-scanning or re-concatenating the whole partial line on every chunk is quadratic in its
  // length, and a Responses `response.completed` line restates the whole output.
  let partial: string[] = []
  let partialLength = 0
  let atStreamStart = true
  // A chunk ending on `\r` may be a `\r\n` split down the middle; the `\n` is not a second line.
  let pendingLf = false
  let event: string | null = null
  let data: string[] = []
  let dataLength = 0
  let failed: TranslationStreamError | null = null

  function dispatch(out: SseFrame[]): void {
    // A frame with no `data:` line at all dispatches nothing — it is a bare comment or a stray
    // `event:`, and inventing an empty payload for it would hand the translator a phantom event.
    if (data.length === 0) {
      event = null
      return
    }
    out.push({ event, data: data.join("\n") })
    event = null
    data = []
    dataLength = 0
  }

  function line(raw: string, out: SseFrame[]): void {
    if (raw.length === 0) {
      dispatch(out)
      return
    }
    if (raw.startsWith(":")) {
      options.onComment?.(raw.slice(1))
      return
    }

    const colon = raw.indexOf(":")
    const field = colon === -1 ? raw : raw.slice(0, colon)
    const rest = colon === -1 ? "" : raw.slice(colon + 1)
    const value = rest.startsWith(" ") ? rest.slice(1) : rest

    if (field === "event") event = value
    else if (field === "data") {
      data.push(value)
      dataLength += value.length
    }
  }

  /** The held partial line plus `text[from, end)`, and the hold emptied. */
  function takeLine(text: string, from: number, end: number): string {
    const tail = text.slice(from, end)
    if (partial.length === 0) return tail
    partial.push(tail)
    const whole = partial.join("")
    partial = []
    partialLength = 0
    return whole
  }

  /** Scans only `text`, never the held partial line: every code unit is visited once. */
  function consume(text: string, out: SseFrame[]): void {
    let from = 0
    for (let cursor = 0; cursor < text.length; cursor += 1) {
      const code = text.charCodeAt(cursor)
      if (code !== LF && code !== CR) continue
      line(takeLine(text, from, cursor), out)
      if (code === CR) {
        if (cursor + 1 === text.length) pendingLf = true
        else if (text.charCodeAt(cursor + 1) === LF) cursor += 1
      }
      from = cursor + 1
    }
    if (from < text.length) {
      partial.push(from === 0 ? text : text.slice(from))
      partialLength += text.length - from
    }
    if (limit !== null && partialLength + dataLength > limit) fail()
  }

  function fail(): void {
    failed = new TranslationStreamError(
      "translation_pending_overflow",
      `An upstream stream event exceeded the ${limit} character translation limit`,
    )
    partial = []
    partialLength = 0
    data = []
    dataLength = 0
    event = null
  }

  function trim(chunk: Uint8Array | string): string {
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    if (atStreamStart && text.length > 0) {
      atStreamStart = false
      if (text.startsWith(BOM)) text = text.slice(1)
    }
    if (pendingLf) {
      pendingLf = false
      if (text.startsWith("\n")) text = text.slice(1)
    }
    return text
  }

  return {
    push(chunk) {
      if (failed !== null) return NONE
      const text = trim(chunk)
      if (text.length === 0) return NONE
      const frames: SseFrame[] = []
      consume(text, frames)
      // Frames completed before the overflowing one in this chunk are still honest output.
      return frames
    },

    /**
     * A trailing frame the upstream left unterminated is **emitted**, not discarded.
     *
     * The browser spec discards it because a reconnect will replay it. There is no reconnect here,
     * and an upstream that closes right after its last `data:` line without the blank line would
     * otherwise cost the client its `message_stop`.
     */
    flush() {
      if (failed !== null) return NONE
      const frames: SseFrame[] = []
      // Flushes any incomplete multi-byte sequence left by the last `stream: true` decode.
      const tail = decoder.decode()
      const rest = takeLine(tail, 0, tail.length)
      pendingLf = false
      if (rest.length > 0) line(rest, frames)
      dispatch(frames)
      return frames
    },

    failure() {
      return failed
    },
  }
}

function frameLimit(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("maximumFrameLength must be a positive integer")
  return value
}

/**
 * A frame's payload as JSON, or null when it is not JSON at all.
 *
 * Null covers both halves of the same decision: the openai-chat `[DONE]` sentinel, which callers
 * test for before decoding, and a genuinely malformed payload. Neither is worth throwing over
 * mid-stream.
 */
export function frameJson(frame: SseFrame): unknown {
  try {
    return JSON.parse(frame.data)
  } catch {
    return null
  }
}
