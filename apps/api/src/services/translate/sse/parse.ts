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
 * Nothing here throws. A malformed frame is a stream already on the wire, and by then the request
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
}

const CR = 13
const LF = 10
const BOM = "﻿"
const NONE: readonly SseFrame[] = []

export interface SseParserOptions {
  /** Called with each comment line's text (the part after the leading `:`), in arrival order. */
  readonly onComment?: (text: string) => void
}

export function createSseParser(options: SseParserOptions = {}): SseParser {
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let atStreamStart = true
  // A chunk ending on `\r` may be a `\r\n` split down the middle; the `\n` is not a second line.
  let pendingLf = false
  let event: string | null = null
  let data: string[] = []

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
    else if (field === "data") data.push(value)
  }

  function consume(text: string, out: SseFrame[]): void {
    buffer += text
    let cursor = 0
    let from = 0
    while (cursor < buffer.length) {
      const code = buffer.charCodeAt(cursor)
      if (code !== LF && code !== CR) {
        cursor += 1
        continue
      }
      line(buffer.slice(from, cursor), out)
      cursor += 1
      if (code === CR) {
        if (cursor === buffer.length) pendingLf = true
        else if (buffer.charCodeAt(cursor) === LF) cursor += 1
      }
      from = cursor
    }
    if (from > 0) buffer = buffer.slice(from)
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
      const text = trim(chunk)
      if (text.length === 0) return NONE
      const frames: SseFrame[] = []
      consume(text, frames)
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
      const frames: SseFrame[] = []
      // Flushes any incomplete multi-byte sequence left by the last `stream: true` decode.
      const tail = decoder.decode()
      const rest = buffer + tail
      buffer = ""
      pendingLf = false
      if (rest.length > 0) line(rest, frames)
      dispatch(frames)
      return frames
    },
  }
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
