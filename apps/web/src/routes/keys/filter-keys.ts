import type { ApiKeyView } from "../../lib/api/types"

// Narrowing the keys table by attribution. Pure on purpose: the same
// exact-match semantics the API's `?owner=` and `?tool=` query params carry,
// applied to the list already in hand — the console keeps the full list so the
// chip vocabulary never shrinks to whatever a filter left behind.

/** Rows carrying this owner and/or this tool. `null` means "no filter". */
export function filterKeys(
  keys: readonly ApiKeyView[],
  owner: string | null,
  tool: string | null,
): readonly ApiKeyView[] {
  return keys.filter(
    (key) => (owner === null || key.owner === owner) && (tool === null || key.tool === tool),
  )
}

/**
 * A selected chip whose value no key carries any more (its last key was deleted
 * or relabelled) is no filter at all: keeping it would hide every row behind a
 * chip that no longer exists, with nothing to press to get back.
 */
export function liveSelection(
  selected: string | null,
  available: readonly string[],
): string | null {
  return selected !== null && available.includes(selected) ? selected : null
}

/** The distinct owners present, sorted — the chips are the fleet's own vocabulary. */
export function distinctOwners(keys: readonly ApiKeyView[]): readonly string[] {
  return distinct(keys.map((key) => key.owner))
}

export function distinctTools(keys: readonly ApiKeyView[]): readonly string[] {
  return distinct(keys.map((key) => key.tool))
}

function distinct(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort()
}
