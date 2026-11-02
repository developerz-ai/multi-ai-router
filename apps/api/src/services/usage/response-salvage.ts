import { createSlotCanonicalizer } from "./response-salvage-canonical"
import {
  BACKSLASH,
  type Capture,
  CLOSE_ARRAY,
  CLOSE_OBJECT,
  COLON,
  COMMA,
  compactSlotEncoding,
  decodeSlotKey,
  isWhitespace,
  KEY_MAX_BYTES,
  OPEN_ARRAY,
  OPEN_OBJECT,
  OPTIONAL,
  PARENT_CHILDREN,
  QUOTE,
  rebuildSalvage,
  SLOT_MAX_BYTES,
  semanticFingerprint,
  slotKeys,
} from "./response-salvage-slots"

export interface ResponseSalvage {
  push(byte: number): void
  /** The rebuilt shallow payload, or null when the scanned bytes were not one closed object. */
  finish(): Record<string, unknown> | null
  readonly retainedBytes: number
}

export function createResponseSalvage(maximumBytes: number): ResponseSalvage {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const captured = new Map<string, number[]>()
  // The escaped captures a literal capture may take the room from, and the ones that stand in for
  // a literal slot: those inherit its priority and give way only when the frame would fail. An
  // escaped copy of the same value the literal slot held is that slot itself — it is in neither
  // set, so no capture takes its room.
  const evictable = new Set<string>()
  const inherited = new Set<string>()
  // Priority alone crosses a parent replacement; no child bytes may survive it.
  const replacedChildren = new Set<string>()
  // One fixed-size semantic digest per literal slot; historical payload arrays must not survive
  // release. Equivalent JSON spellings stand in for the slot the frozen scanner kept (#209).
  const literalValues = new Map<string, string | null>()
  const escapedKeys = [false, false, false]
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
  // Only the latest root error's shape can justify a dropped-object placeholder.
  let sawRootErrorObject = false
  // Depths 1-2: a second value under a key, or a non-string value where a key or colon belongs, is
  // invalid JSON, so the frame keeps no ceiling slot, even one kept earlier (#209). Not a validator.
  const valueStarted: boolean[] = [false, false, false]
  let primitiveRun = false
  let ceilingBlocked = false

  const slotAt = (): string | null => {
    if (depth === 1 && objects[1] && !expectKey[1]) {
      const key = keys[1]
      return key != null && slotKeys("").includes(key) ? key : null
    }
    if (depth !== 2 || !objects[2] || expectKey[2]) return null
    const parent = keys[1]
    const key = keys[2]
    if (parent == null || key == null) return null
    return slotKeys(parent).includes(key) ? `${parent}.${key}` : null
  }
  const optionalMaxBytes = Math.floor(maximumBytes / 4)
  // Release completed captures for room: ceiling slots first, optional evidence only if still full.
  const release = (paths: Iterable<string>) => {
    for (const path of paths) {
      const bytes = captured.get(path)
      if (bytes === undefined) continue
      retained -= bytes.length
      captured.delete(path)
      evictable.delete(path)
      inherited.delete(path)
    }
  }
  // Completed slots lent to optional evidence: restored if it drops, forgotten if it is kept.
  let lent: [string, number[]][] = []
  const lend = (paths: Iterable<string>) => {
    for (const path of paths) {
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
    lent = lent.filter(([path]) => !SLOT_MAX_BYTES.has(path))
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
    // A capture whose key was spelled in escapes gives way at a full budget: it drops itself
    // rather than failing the frame. A literal capture takes the room an escaped one holds
    // instead, so newly decoded slots never crowd out evidence the literal-only scanner kept.
    if (retained >= maximumBytes && !capture.escaped) release(evictable)
    if (retained >= maximumBytes && capture.escaped) {
      // An escaped capture gives way at a full budget: it drops itself rather than failing the
      // frame. Its bytes are canonical already, so there is no encoding overhead to reclaim
      // first: the room it holds is what its value costs.
      retained -= capture.bytes.length
      capture.bytes = []
      capture.dropped = true
      return
    }
    // An escaped replacement of another value — which the frozen scanner never spent room on,
    // since it read the key as raw bytes — yields before a full-budget optional capture drops
    // itself: the evidence the frozen scanner kept must survive (#209: no lost non-stale key). A
    // replacement of the same value is that slot, so the optional capture yields instead.
    if (retained >= maximumBytes && OPTIONAL.has(capture.path)) lend(inherited)
    // Error evidence outranks a ceiling slot: borrow its room before giving way.
    if (OPTIONAL.has(capture.path) && retained >= maximumBytes) lend(SLOT_MAX_BYTES.keys())
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
    // An escaped replacement must yield before literal error evidence is evicted: the frozen
    // scanner never spent room on that replacement (#209: no lost non-stale key).
    if (retained >= maximumBytes) release(inherited)
    if (retained >= maximumBytes) evictOptional()
    if (retained >= maximumBytes) {
      failed = true
      capture = null
      return
    }
    // The captured bytes are canonical: an escaped repeat spends the room its value costs, not
    // the room its spelling spent.
    capture.canonical.push(byte)
    for (const part of capture.canonical.written) {
      capture.bytes.push(part)
      retained++
    }
  }
  const endCapture = () => {
    if (capture === null) return
    // A repeated key replaces the earlier capture, so release the earlier capture's bytes.
    retained -= captured.get(capture.path)?.length ?? 0
    evictable.delete(capture.path)
    inherited.delete(capture.path)
    if (!capture.dropped) {
      // The last bytes of a value are known only at its end: a number's stray point, a fraction
      // of nothing but zeros.
      capture.canonical.end()
      for (const part of capture.canonical.written) {
        capture.bytes.push(part)
        retained++
      }
      const fingerprint = semanticFingerprint(capture.bytes, decoder)
      if (
        capture.escaped &&
        !capture.evictable &&
        fingerprint !== null &&
        fingerprint === literalValues.get(capture.path)
      ) {
        // Equivalent spellings must not spend extra room before inheriting literal priority.
        const compact = compactSlotEncoding(capture.bytes)
        retained -= capture.bytes.length - compact.length
        capture.bytes = compact
      }
      captured.set(capture.path, capture.bytes)
      if (!capture.escaped) literalValues.set(capture.path, fingerprint)
      if (capture.evictable) evictable.add(capture.path)
      // An escaped copy of the same value the literal slot held is that slot, not a replacement:
      // its room is never lent to optional evidence and never released for room, so the key the
      // frozen scanner kept cannot be lost (#209: no lost non-stale key).
      else if (
        capture.escaped &&
        (fingerprint === null || fingerprint !== literalValues.get(capture.path))
      )
        inherited.add(capture.path)
    } else captured.delete(capture.path)
    if (!capture.dropped) {
      for (const [path] of lent) {
        evictable.delete(path)
        inherited.delete(path)
      }
      lent = []
    }
    capture = null
  }
  const beginValue = (byte: number, fresh: boolean) => {
    if (fresh && depth === 1 && objects[1] && !expectKey[1] && keys[1] === "error")
      sawRootErrorObject = byte === OPEN_OBJECT
    if (fresh && depth <= 2 && objects[depth]) {
      if (expectKey[depth] || valueStarted[depth]) blockCeiling()
      valueStarted[depth] = true
    }
    if (capture !== null) return
    // Last wins, as in JSON.parse: a new parent value, or a repeated slot in one parent, replaces
    // what the slot held. Keys are compared decoded, so an escaped slot key is the slot it decodes to.
    if (depth === 1 && objects[1] && !expectKey[1] && keys[1] != null) {
      const children = PARENT_CHILDREN.get(keys[1]) ?? []
      replacedChildren.clear()
      for (const child of children) {
        if (captured.has(child) && !evictable.has(child)) replacedChildren.add(child)
      }
      release(children)
      // A member lent to an error capture in progress is dropped, not given back: its copy is gone.
      lent = lent.filter(([lentPath]) => !children.includes(lentPath))
    }
    const path = slotAt()
    if (path === null) return
    // A key spelled in escapes is matched as the slot it decodes to, but it still gives way at a
    // full budget: it drops itself rather than failing the frame. That holds when it replaces a
    // literal slot too — the literal's bytes are released before the replacement is captured, so
    // the slot reads as absent instead of the frame failing where the frozen scanner did not
    // (#209: no new failure against the previous release).
    const escapedKey = (escapedKeys[1] || (depth === 2 && escapedKeys[2])) === true
    // A repeat of an already retained literal slot inherits its priority: it stands in for the
    // evidence the literal-only scanner kept, so it is not room a literal capture may take.
    const inherits =
      escapedKey && ((captured.has(path) && !evictable.has(path)) || replacedChildren.has(path))
    replacedChildren.delete(path)
    release([path])
    if (SLOT_MAX_BYTES.has(path) && ceilingBlocked) return
    capture = {
      path,
      depth,
      escaped: escapedKey,
      evictable: escapedKey && !inherits,
      kind:
        byte === QUOTE
          ? "string"
          : byte === OPEN_OBJECT || byte === OPEN_ARRAY
            ? "container"
            : "primitive",
      canonical: createSlotCanonicalizer(),
      bytes: [],
      dropped: false,
    }
  }
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
            keys[depth] = decodeSlotKey(keyBytes)
            escapedKeys[depth] = keyBytes.includes(BACKSLASH)
            keyBytes = null
          } else if (capture?.kind === "string" && capture.depth === depth) endCapture()
          return
        }
        if (keyBytes !== null && keyBytes.length <= KEY_MAX_BYTES) keyBytes.push(byte)
        return
      }
      if (isWhitespace(byte)) {
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
      return rebuildSalvage(captured, sawRootErrorObject, decoder)
    },
    get retainedBytes() {
      return retained
    },
  }
}
