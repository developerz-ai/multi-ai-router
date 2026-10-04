import { responseObject } from "./response-usage"

/**
 * Bounded salvage of an oversized JSON payload. Some upstreams echo the whole request into a
 * terminal frame (Codex `response.completed` carries instructions, tools and output), pushing it
 * past the observation cap while the usage that settles the attempt sits inside. This scanner
 * walks the oversized bytes once, retains only the few shallow members usage and terminal
 * evidence are read from, and rebuilds a small payload from them. It never retains more than
 * `maximumBytes` in total; anything it cannot account for honestly yields `null`.
 */

// Shallow members kept verbatim, by parent key (root = ""). Everything else is skipped unread.
const SLOTS: Readonly<Record<string, readonly string[]>> = {
  "": ["type", "usage", "status", "incomplete_details"],
  message: ["usage"],
  response: ["usage", "status", "incomplete_details"],
}
const KEY_MAX_BYTES = 32
const QUOTE = 34
const BACKSLASH = 92
const OPEN_OBJECT = 123
const CLOSE_OBJECT = 125
const OPEN_ARRAY = 91
const CLOSE_ARRAY = 93
const COLON = 58
const COMMA = 44

interface Capture {
  readonly path: string
  readonly depth: number
  readonly kind: "string" | "container" | "primitive"
  bytes: number[]
}

export interface ResponseSalvage {
  push(byte: number): void
  /** The rebuilt shallow payload, or null when the scanned bytes were not one closed object. */
  finish(): Record<string, unknown> | null
  readonly retainedBytes: number
}

export function createResponseSalvage(maximumBytes: number): ResponseSalvage {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const captured = new Map<string, number[]>()
  // Only depths 1 and 2 carry keys we care about; deeper structure is counted, never stored.
  const keys: (string | null)[] = [null, null, null]
  const objects: boolean[] = [false, false, false]
  const expectKey: boolean[] = [false, false, false]
  let depth = 0
  let started = false
  let closed = false
  let failed = false
  let inString = false
  let escaped = false
  let keyBytes: number[] | null = null
  let capture: Capture | null = null
  let retained = 0
  let errorObject = false

  const slotAt = (): string | null => {
    if (depth === 1 && objects[1] && !expectKey[1]) {
      const key = keys[1]
      return key != null && SLOTS[""]?.includes(key) ? key : null
    }
    if (depth === 2 && objects[2] && !expectKey[2]) {
      const parent = keys[1]
      const key = keys[2]
      if (parent == null || key == null) return null
      return SLOTS[parent]?.includes(key) ? `${parent}.${key}` : null
    }
    return null
  }
  const keep = (byte: number) => {
    if (capture === null) return
    if (retained >= maximumBytes) {
      failed = true
      capture = null
      return
    }
    capture.bytes.push(byte)
    retained++
  }
  const endCapture = () => {
    if (capture === null) return
    captured.set(capture.path, capture.bytes)
    capture = null
  }
  const beginValue = (byte: number) => {
    if (depth === 1 && objects[1] && !expectKey[1] && keys[1] === "error" && byte === OPEN_OBJECT)
      errorObject = true
    if (capture !== null) return
    const path = slotAt()
    if (path === null) return
    capture = {
      path,
      depth,
      kind:
        byte === QUOTE
          ? "string"
          : byte === OPEN_OBJECT || byte === OPEN_ARRAY
            ? "container"
            : "primitive",
      bytes: [],
    }
  }
  const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13

  return {
    push(byte) {
      if (failed) return
      if (inString) {
        keep(byte)
        if (escaped) escaped = false
        else if (byte === BACKSLASH) escaped = true
        else if (byte === QUOTE) {
          inString = false
          if (keyBytes !== null) {
            keys[depth] = keyBytes.length <= KEY_MAX_BYTES ? String.fromCharCode(...keyBytes) : null
            keyBytes = null
          } else if (capture?.kind === "string" && capture.depth === depth) endCapture()
          return
        }
        if (keyBytes !== null && keyBytes.length <= KEY_MAX_BYTES) keyBytes.push(byte)
        return
      }
      if (whitespace(byte)) {
        if (capture?.kind === "primitive" && capture.depth === depth) endCapture()
        else keep(byte)
        return
      }
      if (closed) {
        failed = true
        return
      }
      if (capture?.kind === "primitive" && capture.depth === depth) {
        if (byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) endCapture()
      }
      if (!started) {
        if (byte !== OPEN_OBJECT) {
          failed = true
          return
        }
        started = true
      }
      switch (byte) {
        case QUOTE:
          inString = true
          if (depth >= 1 && depth <= 2 && objects[depth] && expectKey[depth]) {
            keyBytes = []
            keys[depth] = null
            keep(byte)
            return
          }
          beginValue(byte)
          keep(byte)
          return
        case OPEN_OBJECT:
        case OPEN_ARRAY:
          if (depth > 0) beginValue(byte)
          keep(byte)
          depth++
          if (depth <= 2) {
            objects[depth] = byte === OPEN_OBJECT
            expectKey[depth] = byte === OPEN_OBJECT
            keys[depth] = null
          }
          return
        case CLOSE_OBJECT:
        case CLOSE_ARRAY:
          if (depth === 0) {
            failed = true
            return
          }
          keep(byte)
          depth--
          if (capture?.kind === "container" && capture.depth === depth) endCapture()
          if (depth === 0) closed = true
          return
        case COLON:
          if (depth <= 2) expectKey[depth] = false
          keep(byte)
          return
        case COMMA:
          if (depth <= 2 && objects[depth]) expectKey[depth] = true
          keep(byte)
          return
        default:
          if (depth === 0) {
            failed = true
            return
          }
          if (capture === null) beginValue(byte)
          keep(byte)
      }
    },
    finish() {
      if (failed || !closed || inString) return null
      const parts: Record<string, unknown> = {}
      try {
        for (const [path, bytes] of captured) {
          const value: unknown = JSON.parse(decoder.decode(Uint8Array.from(bytes)))
          const [first, second] = path.split(".")
          if (first === undefined) continue
          if (second === undefined) parts[first] = value
          else {
            const parent = responseObject(parts[first]) ?? {}
            parent[second] = value
            parts[first] = parent
          }
        }
      } catch {
        return null
      }
      if (errorObject) parts.error = {}
      return parts
    },
    get retainedBytes() {
      return retained
    },
  }
}
