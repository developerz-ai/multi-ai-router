import { responseObject } from "./response-usage"

/**
 * The salvage scanner's slot tables and its final rebuild step, kept apart from the byte-level
 * state machine in `response-salvage.ts`.
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
export const OPTIONAL = new Set(["error", "code", "response.error"])
/**
 * Slots with their own ceiling: dropped past it, or when the budget is full (without evicting
 * anything else), released before a required member would fail the salvage, and lent to error
 * evidence that needs the room (given back if that evidence drops anyway). Losing one reads as
 * before the slot existed; it never fails the salvage. A MiniMax status
 * code is a small integer; anything longer cannot classify anyway.
 */
export const SLOT_MAX_BYTES: ReadonlyMap<string, number> = new Map([["base_resp.status_code", 32]])
/** Each ceiling slot by the root key that parents it, so a repeated parent releases its children. */
export const CEILING_CHILDREN: ReadonlyMap<string, readonly string[]> = Map.groupBy(
  SLOT_MAX_BYTES.keys(),
  (path) => path.split(".")[0] ?? "",
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

/** A parent key's slot list; own keys only, so a key named `constructor` is no slot at all. */
export function slotKeys(parent: string): readonly string[] {
  return Object.hasOwn(SLOTS, parent) ? (SLOTS[parent] ?? []) : []
}

/**
 * The rebuilt shallow payload from the captured slots, or null when a required or optional member
 * does not parse. A malformed ceiling slot is lost as if it never existed.
 */
export function rebuildSalvage(
  captured: ReadonlyMap<string, readonly number[]>,
  errorObject: boolean,
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
  if (errorObject && responseObject(parts.error) === undefined) parts.error = {}
  return parts
}
