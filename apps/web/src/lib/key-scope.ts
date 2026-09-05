import type { AccountView, KeyScopeView, PoolView } from "./api/types"

// Which accounts a router key can actually reach. Pure — a scope, the pools and the accounts in,
// the reachable set out — and the mirror of the one rule the router enforces: candidates are
// always pool members ∩ key scope (CLAUDE.md non-negotiable 6). Nothing here widens.

/** The ids a key's scope resolves to. `all` reaches every account the router holds. */
export function reachableAccountIds(
  scope: KeyScopeView,
  pools: readonly PoolView[],
  accounts: readonly AccountView[],
): ReadonlySet<string> {
  if (scope.kind === "all") return new Set(accounts.map((account) => account.id))
  if (scope.kind === "accounts") return new Set(scope.accountIds)
  const ids = new Set<string>()
  for (const pool of pools) {
    if (!scope.poolIds.includes(pool.id)) continue
    for (const member of pool.members) ids.add(member.accountId)
  }
  return ids
}

/** True when at least one reachable account satisfies the predicate. */
export function scopeReaches(
  scope: KeyScopeView,
  pools: readonly PoolView[],
  accounts: readonly AccountView[],
  predicate: (account: AccountView) => boolean,
): boolean {
  const ids = reachableAccountIds(scope, pools, accounts)
  return accounts.some((account) => ids.has(account.id) && predicate(account))
}
