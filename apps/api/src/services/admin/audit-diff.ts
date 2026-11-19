/**
 * What a set-replacing write changed, for an audit row's `detail` (multi-ai-router#454).
 *
 * Pool membership and key scope are both written as a whole set, so "what changed" is never in the
 * request: it is the difference between the set held before the write and the set after it. Rows
 * name each id with its operator-facing name, because an audit read months later must answer
 * "which account left this pool" without the account still existing. Names only, never a value:
 * the caller resolves a name from a label or a pool/key name, nothing that carries a credential.
 */

export interface IdDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/** Pure. Order follows each side's own listing; a repeated id counts once. */
export function diffIds(before: readonly string[], after: readonly string[]): IdDiff {
  const held = new Set(before)
  const kept = new Set(after)
  return {
    added: [...kept].filter((id) => !held.has(id)),
    removed: [...held].filter((id) => !kept.has(id)),
  }
}

/** `{ accountId, name }` per id; an id whose name is not known is kept, named `null`. */
export function namedAccounts(
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
): { readonly accountId: string; readonly name: string | null }[] {
  return ids.map((accountId) => ({ accountId, name: names.get(accountId) ?? null }))
}

/** `{ poolId, name }` per id; an id whose name is not known is kept, named `null`. */
export function namedPools(
  ids: readonly string[],
  names: ReadonlyMap<string, string>,
): { readonly poolId: string; readonly name: string | null }[] {
  return ids.map((poolId) => ({ poolId, name: names.get(poolId) ?? null }))
}
