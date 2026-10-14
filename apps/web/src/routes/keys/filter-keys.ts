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
