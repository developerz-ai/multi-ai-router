import { createHash } from "node:crypto"
import { responseObject } from "./response-usage"

/**
 * The salvage scanner's slot tables, the byte constants its lexer reads, and its final rebuild step,
 * kept apart from the byte-level state machine in `response-salvage.ts`.
 */

export interface Capture {
  readonly path: string
  readonly depth: number
  readonly kind: "string" | "container" | "primitive"
  /** A key spelled in escapes: the capture gives way at a full budget instead of failing the frame. */
  readonly escaped: boolean
  /** A literal capture may take the room this capture holds; it gives way before that evidence. */
  readonly evictable: boolean
  bytes: number[]
  dropped: boolean
}

// Shallow members kept verbatim, by parent key (root = ""). Everything else is skipped unread.
const SLOTS: Readonly<Record<string, readonly string[]>> = {
  "": ["type", "usage", "status", "incomplete_details", "error", "code"],
  // MiniMax carries its failures on a 200 in `base_resp`; only the number classifies, so the
  // free-text `status_msg` beside it is never kept. Kept unless it is over its ceiling, the budget is
  // full (`SLOT_MAX_BYTES`), it is malformed, or the frame trips the structural check; losing it reads
  // as before the slot existed.
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
export const OPTIONAL: ReadonlySet<string> = new Set(["error", "code", "response.error"])
/**
 * Slots with their own ceiling: dropped past it, or when the budget is full (without evicting
 * anything else), released before a required member would fail the salvage, and lent to error
 * evidence that needs the room (given back if that evidence drops anyway). Losing one reads as
 * before the slot existed; it never fails the salvage. A MiniMax status
 * code is a small integer; anything longer cannot classify anyway.
 */
export const SLOT_MAX_BYTES: ReadonlyMap<string, number> = new Map([["base_resp.status_code", 32]])
/**
 * Every slot member by the root key that parents it, so a repeated parent releases the members
 * captured under the copy it replaces: `JSON.parse` reads the last copy only, and a member left
 * behind would be merged into it.
 */
export const PARENT_CHILDREN: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(SLOTS)
    .filter(([parent]) => parent !== "")
    .map(([parent, slots]) => [parent, slots.map((slot) => `${parent}.${slot}`)] as const),
)
export const KEY_MAX_BYTES = 32
export const QUOTE = 34
export const BACKSLASH = 92
export const OPEN_OBJECT = 123
export const CLOSE_OBJECT = 125
export const OPEN_ARRAY = 91
export const CLOSE_ARRAY = 93
export const COLON = 58
export const COMMA = 44

/** The bytes between tokens: space, tab, line feed, carriage return. */
export function isWhitespace(byte: number): boolean {
  return byte === 32 || byte === 9 || byte === 10 || byte === 13
}

/** Remove insignificant whitespace without changing strings or requiring recursive serialization. */
export function compactSlotEncoding(bytes: readonly number[]): number[] {
  let inString = false
  let escaped = false
  return bytes.filter((byte) => {
    if (inString) {
      if (escaped) escaped = false
      else if (byte === BACKSLASH) escaped = true
      else if (byte === QUOTE) inString = false
      return true
    }
    if (byte === QUOTE) inString = true
    return !isWhitespace(byte)
  })
}

/** Fixed-size comparison metadata; never retain a historical capture or its parsed value. */
export function semanticFingerprint(bytes: readonly number[], decoder: TextDecoder): string | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(Uint8Array.from(bytes)))
    const hash = createHash("sha256")
    // Iterative traversal avoids a call-stack limit on deeply nested, but bounded, captures.
    const pending: unknown[] = [value]
    while (pending.length > 0) {
      const item = pending.pop()
      if (Array.isArray(item)) {
        hash.update(`array:${item.length}:`)
        for (let at = item.length - 1; at >= 0; at--) pending.push(item[at])
      } else if (item !== null && typeof item === "object") {
        const object = item as Record<string, unknown>
        const keys = Object.keys(object).sort()
        hash.update(`object:${keys.length}:`)
        for (let at = keys.length - 1; at >= 0; at--) {
          const key = keys[at]
          if (key !== undefined) pending.push(object[key], key)
        }
      } else
        hash.update(
          `${typeof item}:${typeof item === "number" ? String(item) : JSON.stringify(item)};`,
        )
    }
    return hash.digest("hex")
  } catch {
    return null
  }
}

/** A parent key's slot list; own keys only, so a key named `constructor` is no slot at all. */
export function slotKeys(parent: string): readonly string[] {
  return Object.hasOwn(SLOTS, parent) ? (SLOTS[parent] ?? []) : []
}

const HEX_ESCAPE = /^[0-9a-fA-F]{4}$/

/**
 * The name a JSON member has, decoded from the raw bytes of its key: `\"`, `\\`, `\/`, `\b`, `\f`,
 * `\n`, `\r`, `\t` and `\uXXXX`. A key that is not pure ASCII, an invalid escape, or a raw key over
 * `KEY_MAX_BYTES` is no slot at all: every slot name is ASCII, so such a key could never be one.
 */
export function decodeSlotKey(raw: readonly number[]): string | null {
  if (raw.length > KEY_MAX_BYTES) return null
  let key = ""
  for (let at = 0; at < raw.length; at++) {
    const byte = raw[at]
    if (byte === undefined) return null
    if (byte !== BACKSLASH) {
      if (byte > 0x7f) return null
      key += String.fromCharCode(byte)
      continue
    }
    const escapeByte = raw[at + 1]
    at++
    switch (escapeByte) {
      case QUOTE:
        key += '"'
        break
      case BACKSLASH:
        key += "\\"
        break
      case 47: // "/"
        key += "/"
        break
      case 98: // "b"
        key += "\b"
        break
      case 102: // "f"
        key += "\f"
        break
      case 110: // "n"
        key += "\n"
        break
      case 114: // "r"
        key += "\r"
        break
      case 116: // "t"
        key += "\t"
        break
      case 117: {
        // "u": the four hex digits of the code point that follows.
        const hex = String.fromCharCode(...raw.slice(at + 1, at + 5))
        if (!HEX_ESCAPE.test(hex)) return null
        at += 4
        const code = Number.parseInt(hex, 16)
        if (code > 0x7f) return null
        key += String.fromCharCode(code)
        break
      }
      default:
        return null
    }
  }
  return key
}

/**
 * The rebuilt shallow payload from the captured slots, or null when a required or optional member
 * does not parse. A malformed ceiling slot is lost as if it never existed. `sawRootErrorObject`
 * says the latest root `error` was an object: `{}` stands in for one that could not be kept, so the frame
 * still reads as a failure and never as a success. A kept root `error` value — of any shape — is
 * left alone.
 */
export function rebuildSalvage(
  captured: ReadonlyMap<string, readonly number[]>,
  sawRootErrorObject: boolean,
  decoder: TextDecoder,
): Record<string, unknown> | null {
  const parts: Record<string, unknown> = {}
  try {
    for (const [path, bytes] of captured) {
      let value: unknown
      try {
        value = JSON.parse(decoder.decode(Uint8Array.from(bytes)))
      } catch (error) {
        // A malformed ceiling slot is lost as if it never existed; anything else fails as before.
        if (SLOT_MAX_BYTES.has(path)) continue
        throw error
      }
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
  // The placeholder stands in only for a root error that could not be kept: a kept value — object,
  // string, null, number — is left as it is.
  if (sawRootErrorObject && parts.error === undefined) parts.error = {}
  return parts
}
