import { responseObject } from "./response-usage"

/**
 * Bounded salvage of an oversized JSON payload. Some upstreams echo the whole request into a
 * terminal frame (Codex `response.completed` carries instructions, tools and output), pushing it
 * past the observation cap while the usage that settles the attempt sits inside. This scanner
 * walks the oversized bytes once, retains only the few shallow members usage and terminal
 * evidence are read from, and rebuilds a small payload from them. It never counts more than
 * `maximumBytes`, plus at most one ceiling slot's bytes held aside while lent to an error capture in
 * progress; anything it cannot account for honestly yields `null`.
 */

// Shallow members kept verbatim, by parent key (root = ""). Everything else is skipped unread.
const SLOTS: Readonly<Record<string, readonly string[]>> = {
  "": ["type", "usage", "status", "incomplete_details", "error", "code"],
  // MiniMax carries its failures on a 200 in `base_resp`; only the number classifies, so the
  // free-text `status_msg` beside it is never kept. Kept unless it is over its ceiling or the budget
  // is full (`SLOT_MAX_BYTES`); losing it reads as before the slot existed.
  base_resp: ["status_code"],
  message: ["usage"],
  response: ["usage", "status", "incomplete_details", "error"],
}
/**
 * Error evidence a driver hook classifies from (`code`, the nested `error`; a root `message` is
 * Anthropic's message object, so it is not a slot). Kept when it is small,
 * and dropped — never failing the salvage — when it is not: a lost code reads as an unclassified
 * failure, while a failed salvage would lose the failure itself.
 */
const OPTIONAL = new Set(["error", "code", "response.error"])
/**
 * Slots with their own ceiling: dropped past it, or when the budget is full (without evicting
 * anything else), released before a required member would fail the salvage, and lent to error
 * evidence that needs the room (given back if that evidence drops anyway). Losing one reads as
 * before the slot existed; it never fails the salvage. A MiniMax status
 * code is a small integer; anything longer cannot classify anyway.
 */
const SLOT_MAX_BYTES: ReadonlyMap<string, number> = new Map([["base_resp.status_code", 32]])
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
  /** An optional slot that outgrew its share: its bytes are released and nothing is kept. */
  dropped: boolean
}

export interface ResponseSalvage {
  push(byte: number): void
  /** The rebuilt shallow payload, or null when the scanned bytes were not one closed object. */
  finish(): Record<string, unknown> | null
  readonly retainedBytes: number
}

/** A parent key's slot list; own keys only, so a key named `constructor` is no slot at all. */
function slotKeys(parent: string): readonly string[] {
  return Object.hasOwn(SLOTS, parent) ? (SLOTS[parent] ?? []) : []
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
      return key != null && slotKeys("").includes(key) ? key : null
    }
    if (depth === 2 && objects[2] && !expectKey[2]) {
      const parent = keys[1]
      const key = keys[2]
      if (parent == null || key == null) return null
      return slotKeys(parent).includes(key) ? `${parent}.${key}` : null
    }
    return null
  }
  const optionalMaxBytes = Math.floor(maximumBytes / 4)
  // Release completed captures for room, never a failed salvage: the ceiling slots first, and the
  // optional error evidence only if that was not enough.
  const release = (paths: Iterable<string>) => {
    for (const path of paths) {
      const bytes = captured.get(path)
      if (bytes === undefined) continue
      retained -= bytes.length
      captured.delete(path)
    }
  }
  // Ceiling-slot captures lent to the error capture in progress: given back if it drops anyway,
  // forgotten once it is kept. A dropping capture frees at least what it borrowed, so they fit.
  let lent: [string, number[]][] = []
  const lend = () => {
    for (const path of SLOT_MAX_BYTES.keys()) {
      const bytes = captured.get(path)
      if (bytes === undefined) continue
      lent.push([path, bytes])
      retained -= bytes.length
      captured.delete(path)
    }
  }
  const giveBack = () => {
    for (const [path, bytes] of lent) {
      captured.set(path, bytes)
      retained += bytes.length
    }
    lent = []
  }
  const evictOptional = () => {
    release(SLOT_MAX_BYTES.keys())
    if (retained >= maximumBytes) release(OPTIONAL)
  }
  const keep = (byte: number) => {
    if (capture === null || capture.dropped) return
    const ceiling = SLOT_MAX_BYTES.get(capture.path)
    // Error evidence outranks a ceiling slot: borrow its room before giving way.
    if (OPTIONAL.has(capture.path) && retained >= maximumBytes && lent.length === 0) lend()
    if (
      (ceiling !== undefined && capture.bytes.length >= ceiling) ||
      (OPTIONAL.has(capture.path) &&
        (capture.bytes.length >= optionalMaxBytes || retained >= maximumBytes))
    ) {
      retained -= capture.bytes.length
      capture.bytes = []
      capture.dropped = true
      giveBack()
      return
    }
    // A ceiling slot gives way itself at a full budget; it never evicts the evidence others hold.
    if (retained >= maximumBytes && ceiling !== undefined) {
      retained -= capture.bytes.length
      capture.bytes = []
      capture.dropped = true
      return
    }
    if (retained >= maximumBytes) evictOptional()
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
    // A repeated key replaces the earlier capture, so release the earlier capture's bytes.
    retained -= captured.get(capture.path)?.length ?? 0
    if (!capture.dropped) captured.set(capture.path, capture.bytes)
    else captured.delete(capture.path)
    if (!capture.dropped) lent = []
    capture = null
  }
  const beginValue = (byte: number) => {
    if (depth === 1 && objects[1] && !expectKey[1] && keys[1] === "error" && byte === OPEN_OBJECT)
      errorObject = true
    if (capture !== null) return
    const path = slotAt()
    if (path === null) return
    // Last wins, as in JSON.parse: a repeated ceiling slot's earlier copy is dead either way.
    if (SLOT_MAX_BYTES.has(path)) release([path])
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
      dropped: false,
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
      if (errorObject && responseObject(parts.error) === undefined) parts.error = {}
      return parts
    },
    get retainedBytes() {
      return retained
    },
  }
}
