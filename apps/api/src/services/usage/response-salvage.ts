import {
  BACKSLASH,
  CEILING_CHILDREN,
  CLOSE_ARRAY,
  CLOSE_OBJECT,
  COLON,
  COMMA,
  KEY_MAX_BYTES,
  OPEN_ARRAY,
  OPEN_OBJECT,
  OPTIONAL,
  QUOTE,
  rebuildSalvage,
  SLOT_MAX_BYTES,
  slotKeys,
} from "./response-salvage-slots"

/**
 * Bounded salvage of an oversized JSON payload. Some upstreams echo the whole request into a
 * terminal frame (Codex `response.completed` carries instructions, tools and output), pushing it
 * past the observation cap while the usage that settles the attempt sits inside. This scanner
 * walks the oversized bytes once, retains only the few shallow members usage and terminal
 * evidence are read from, and rebuilds a small payload from them. It never counts more than
 * `maximumBytes`; one lent ceiling slot (32 bytes at most) is held aside beyond it. Anything it
 * cannot account for honestly yields `null`.
 */

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
  // Depths 1-2: a second value under a key, or a non-string value where a key or colon belongs, is
  // invalid JSON, so the frame keeps no ceiling slot, even one kept earlier. Not a validator: other
  // malformed frames can still yield a code (#209). `primitiveRun` marks continuation bytes.
  const valueStarted: boolean[] = [false, false, false]
  let primitiveRun = false
  let ceilingBlocked = false

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
  // Release completed captures for room: ceiling slots first, optional evidence only if still full.
  const release = (paths: Iterable<string>) => {
    for (const path of paths) {
      const bytes = captured.get(path)
      if (bytes === undefined) continue
      retained -= bytes.length
      captured.delete(path)
    }
  }
  // Ceiling slots lent to the error capture in progress: given back if it drops (it frees at least
  // what it borrowed, so they fit), forgotten once it is kept.
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
  const blockCeiling = () => {
    ceilingBlocked = true
    release(SLOT_MAX_BYTES.keys())
    lent = []
    if (capture === null || !SLOT_MAX_BYTES.has(capture.path) || capture.dropped) return
    retained -= capture.bytes.length
    capture.bytes = []
    capture.dropped = true
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
  const beginValue = (byte: number, fresh: boolean) => {
    if (depth === 1 && objects[1] && !expectKey[1] && keys[1] === "error" && byte === OPEN_OBJECT)
      errorObject = true
    if (fresh && depth <= 2 && objects[depth]) {
      if (expectKey[depth] || valueStarted[depth]) blockCeiling()
      valueStarted[depth] = true
    }
    if (capture !== null) return
    // Last wins, as in JSON.parse: a new parent value, or a repeated slot in one parent, replaces
    // what the slot held. Keys are compared as raw bytes, escapes not decoded, like every slot (#209).
    if (depth === 1 && objects[1] && !expectKey[1] && keys[1] != null) {
      release(CEILING_CHILDREN.get(keys[1]) ?? [])
    }
    const path = slotAt()
    if (path === null) return
    if (SLOT_MAX_BYTES.has(path)) {
      release([path])
      if (ceilingBlocked) return
    }
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
        primitiveRun = false
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
      const continuesPrimitive = primitiveRun
      primitiveRun = false
      switch (byte) {
        case QUOTE:
          inString = true
          if (depth >= 1 && depth <= 2 && objects[depth] && expectKey[depth]) {
            keyBytes = []
            keys[depth] = null
            valueStarted[depth] = false
            keep(byte)
            return
          }
          beginValue(byte, true)
          keep(byte)
          return
        case OPEN_OBJECT:
        case OPEN_ARRAY:
          if (depth > 0) beginValue(byte, true)
          keep(byte)
          depth++
          if (depth <= 2) {
            objects[depth] = byte === OPEN_OBJECT
            expectKey[depth] = byte === OPEN_OBJECT
            keys[depth] = null
            valueStarted[depth] = false
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
          primitiveRun = true
          if (capture === null || !continuesPrimitive) beginValue(byte, !continuesPrimitive)
          keep(byte)
      }
    },
    finish() {
      if (failed || !closed || inString) return null
      return rebuildSalvage(captured, errorObject, decoder)
    },
    get retainedBytes() {
      return retained
    },
  }
}
