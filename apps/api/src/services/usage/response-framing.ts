import { createResponseSalvage, type ResponseSalvage } from "./response-salvage"

const LF = 10
const CR = 13
const SPACE = 32
const DATA_FIELD = [100, 97, 116, 97, 58] // "data:"
const encoder = new TextEncoder()

/**
 * Observes complete bounded frames independently of the already-forwarded byte stream.
 *
 * This runs on the shared event loop for every relayed chunk, so it never walks bytes in JS where a
 * native scan will do: line breaks are found with `indexOf`, a partial line is held as the chunk
 * slices that make it up and decoded once when it completes, and a JSON body is held as chunk
 * copies and concatenated once at `finish` (docs/idea/08-observability.md, "Observation cost").
 */
export function createResponseFraming(input: {
  readonly contentType: string | null
  readonly maximumBytes: number
  readonly payload: (body: unknown, event: string | undefined) => void
  readonly done: () => void
  readonly unavailable: () => void
  /**
   * Frames the caller has no use for, decided before their bytes are decoded (by `event:` name)
   * or parsed (by the decoded `data` text). A skipped frame is counted, never held or reported.
   */
  readonly skip?: {
    readonly event?: (name: string) => boolean
    readonly data?: (text: string) => boolean
  }
}) {
  const media = input.contentType?.split(";", 1)[0]?.trim().toLowerCase()
  const sse = media === "text/event-stream"
  const json = media === "application/json" || media?.endsWith("+json") === true
  const decoder = new TextDecoder("utf-8", { fatal: true })
  // The pending partial SSE line, or the whole JSON body under the bound.
  let parts: Uint8Array[] = []
  let partBytes = 0
  let data: string[] = []
  let event: string | undefined
  let eventBytes = 0
  let dropping = false
  let skipping = false
  let pendingCR = false
  let ended = false
  // An over-cap frame is not dropped outright: its bytes stream through a bounded salvage scanner
  // that keeps only the shallow usage/terminal members (see response-salvage.ts).
  let salvage: ResponseSalvage | null = null
  let salvageLineBytes = 0
  let salvageField: "pending" | "data" | "skip" = "pending"
  let salvageDataSeen = false
  let salvageSpace = false
  const parse = (text: string, name?: string) => {
    if (text === "[DONE]") {
      if (sse) input.done()
      else input.unavailable()
      return
    }
    if (sse && input.skip?.data?.(text) === true) return
    try {
      input.payload(JSON.parse(text), name)
    } catch {
      input.unavailable()
    }
  }
  const reset = () => {
    data = []
    event = undefined
    eventBytes = 0
    dropping = false
    skipping = false
    salvage = null
  }
  const takeLine = (): Uint8Array => {
    const [only] = parts
    const line = parts.length === 1 && only !== undefined ? only : concat(parts, partBytes)
    parts = []
    partBytes = 0
    return line
  }
  const settleSalvage = (scanner: ResponseSalvage) => {
    const body = scanner.finish()
    if (body === null) input.unavailable()
    else input.payload(body, event)
  }
  /** SSE field handling while salvaging: only `data:` values reach the scanner, joined by LF. */
  const salvageRange = (
    scanner: ResponseSalvage,
    bytes: Uint8Array,
    start: number,
    end: number,
  ) => {
    if (!sse) {
      scanner.pushChunk(bytes, start, end)
      return
    }
    let at = start
    while (at < end && salvageField === "pending") {
      const byte = bytes[at] ?? 0
      const index = salvageLineBytes++
      at++
      if (byte !== DATA_FIELD[index]) salvageField = "skip"
      else if (index === DATA_FIELD.length - 1) {
        salvageField = "data"
        salvageSpace = true
        if (salvageDataSeen) scanner.push(LF)
        salvageDataSeen = true
      }
    }
    if (at >= end) return
    salvageLineBytes += end - at
    if (salvageField !== "data") return
    if (salvageSpace) {
      salvageSpace = false
      if (bytes[at] === SPACE) at++
    }
    scanner.pushChunk(bytes, at, end)
  }
  const startSalvage = (): ResponseSalvage => {
    const scanner = createResponseSalvage(input.maximumBytes)
    data.forEach((text, index) => {
      if (index > 0) scanner.push(LF)
      const bytes = encoder.encode(text)
      scanner.pushChunk(bytes, 0, bytes.length)
    })
    salvageDataSeen = data.length > 0
    salvageLineBytes = 0
    salvageField = "pending"
    data = []
    eventBytes = 0
    salvage = scanner
    return scanner
  }
  /** Adds `bytes[start, end)` to the current line; `own` copies a tail the caller may reuse. */
  const append = (bytes: Uint8Array, start: number, end: number, own: boolean) => {
    if (start === end) return
    if (salvage !== null) {
      salvageRange(salvage, bytes, start, end)
      return
    }
    // A discarded line still needs its length distinction at the next blank boundary.
    if (dropping || skipping) {
      partBytes += end - start
      return
    }
    if (partBytes + (end - start) + eventBytes > input.maximumBytes) {
      const held = parts
      parts = []
      partBytes = 0
      const scanner = startSalvage()
      for (const part of held) salvageRange(scanner, part, 0, part.length)
      salvageRange(scanner, bytes, start, end)
      return
    }
    const slice = bytes.subarray(start, end)
    parts.push(own ? slice.slice() : slice)
    partBytes += end - start
  }
  const consumeLine = () => {
    if (salvage !== null) {
      if (salvageLineBytes === 0) {
        settleSalvage(salvage)
        reset()
      }
      salvageLineBytes = 0
      salvageField = "pending"
      return
    }
    if (partBytes === 0) {
      if (!dropping && !skipping && data.length > 0) parse(data.join("\n"), event)
      reset()
      return
    }
    if (dropping || skipping) {
      parts = []
      partBytes = 0
      return
    }
    const bytes = partBytes
    let text: string
    try {
      text = decoder.decode(takeLine())
    } catch {
      input.unavailable()
      dropping = true
      return
    }
    if (text.startsWith("data:")) {
      data.push(text.charCodeAt(5) === SPACE ? text.slice(6) : text.slice(5))
      eventBytes += bytes + 1
    } else if (text.startsWith("event:")) {
      event = text.slice(6).trimStart()
      eventBytes += bytes
      if (input.skip?.event?.(event) === true) {
        skipping = true
        data = []
        eventBytes = 0
      }
    }
    if (eventBytes > input.maximumBytes) startSalvage()
  }
  const observeSse = (chunk: Uint8Array) => {
    if (chunk.length === 0) return
    let from = 0
    if (pendingCR && chunk[0] === LF) from = 1
    pendingCR = false
    // CR is rare on the wire; its position is found once and reused until the scan passes it.
    let crAt = -2
    while (from < chunk.length) {
      if (crAt !== -1 && crAt < from) crAt = chunk.indexOf(CR, from)
      const lfAt = chunk.indexOf(LF, from)
      const lineEnd = crAt === -1 ? lfAt : lfAt === -1 ? crAt : Math.min(lfAt, crAt)
      if (lineEnd === -1) {
        append(chunk, from, chunk.length, true)
        return
      }
      append(chunk, from, lineEnd, false)
      consumeLine()
      from = lineEnd + 1
      if (chunk[lineEnd] === CR) {
        if (from === chunk.length) pendingCR = true
        else if (chunk[from] === LF) from++
      }
    }
  }
  return {
    observe(chunk: Uint8Array) {
      if (ended) return
      if (!sse && !json) {
        input.unavailable()
        return
      }
      if (sse) observeSse(chunk)
      else append(chunk, 0, chunk.length, true)
    },
    finish() {
      if (ended) return
      ended = true
      if (json && salvage !== null) settleSalvage(salvage)
      else if (json && !dropping && partBytes > 0) {
        let text: string | undefined
        try {
          text = decoder.decode(takeLine())
        } catch {
          input.unavailable()
        }
        if (text !== undefined) parse(text)
      } else if (!sse && !json) input.unavailable()
      else if (partBytes > 0 || data.length > 0 || dropping || salvage !== null) input.unavailable()
      parts = []
      partBytes = 0
      reset()
    },
    get retainedBytes() {
      return (dropping || skipping ? 0 : partBytes) + eventBytes + (salvage?.retainedBytes ?? 0)
    },
  }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
