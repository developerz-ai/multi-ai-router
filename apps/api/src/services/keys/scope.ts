import type { KeyScope } from "@multi-ai-router/core"
import type { AccountRepository, PoolRepository } from "@multi-ai-router/db"
import { diffIds, namedAccounts, namedPools } from "../admin/audit-diff"
import { type AdminResult, invalid, ok } from "../admin/result"
import type { KeyScopeInput } from "./schemas"

/**
 * Scope targets are checked to exist **at write time**.
 *
 * Enforcement is still at selection time — that is what makes editing a pool or
 * disabling an account take effect on the next request with no re-mint
 * (docs/idea/04-api-keys-and-access.md#how-scope-is-enforced). This is a
 * different question: a scope naming an id that never existed is a typo, and
 * the only place it can be reported usefully is the request that made it.
 * Left unchecked it becomes an empty candidate set hours later, reported as
 * "this key reaches nothing" with no hint that the id was wrong all along.
 */

export interface ResolvedScope {
  readonly kind: KeyScope
  readonly poolIds: readonly string[]
  readonly accountIds: readonly string[]
}

export interface ScopeResolverDeps {
  readonly pools: Pick<PoolRepository, "findByIds">
  readonly accounts: Pick<AccountRepository, "findByIds">
}

export async function resolveScopeInput(
  deps: ScopeResolverDeps,
  scope: KeyScopeInput,
): Promise<AdminResult<ResolvedScope>> {
  if (scope.kind === "all") {
    return ok({ kind: "all", poolIds: [], accountIds: [] })
  }

  if (scope.kind === "pools") {
    const poolIds = unique(scope.poolIds)
    const found = await deps.pools.findByIds(poolIds)
    const missing = absent(poolIds, found)
    if (missing.length > 0) {
      return invalid(`scope names ${label("pool", missing)}, which do not exist`, "unknown_pool")
    }
    return ok({ kind: "pools", poolIds, accountIds: [] })
  }

  const accountIds = unique(scope.accountIds)
  const found = await deps.accounts.findByIds(accountIds)
  const missing = absent(accountIds, found)
  if (missing.length > 0) {
    return invalid(
      `scope names ${label("account", missing)}, which do not exist`,
      "unknown_account",
    )
  }
  return ok({ kind: "accounts", poolIds: [], accountIds })
}

/**
 * `key.updated`'s scope fields for a write that sent a scope (multi-ai-router#454): the targets the
 * scope gained and lost, with their names. `scopeBefore` sits beside the row's `scope` because a
 * `pools` → `all` widen empties the target list, and would otherwise read as a narrowing.
 */
export async function scopeChange(
  deps: ScopeResolverDeps,
  before: KeyScope,
  held: { readonly poolIds: readonly string[]; readonly accountIds: readonly string[] },
  after: ResolvedScope,
) {
  const pools = diffIds(held.poolIds, after.poolIds)
  const accounts = diffIds(held.accountIds, after.accountIds)
  const poolNames = new Map(
    (await deps.pools.findByIds([...pools.added, ...pools.removed])).map((row) => [
      row.id,
      row.name,
    ]),
  )
  const accountNames = new Map(
    (await deps.accounts.findByIds([...accounts.added, ...accounts.removed])).map((row) => [
      row.id,
      row.label,
    ]),
  )
  return {
    scopeBefore: before,
    poolsAdded: namedPools(pools.added, poolNames),
    poolsRemoved: namedPools(pools.removed, poolNames),
    accountsAdded: namedAccounts(accounts.added, accountNames),
    accountsRemoved: namedAccounts(accounts.removed, accountNames),
  }
}

/** A repeated id is a duplicate row against a unique index, not a second grant. */
function unique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)]
}

function absent(requested: readonly string[], found: readonly { id: string }[]): readonly string[] {
  const present = new Set(found.map((row) => row.id))
  return requested.filter((id) => !present.has(id))
}

function label(noun: string, ids: readonly string[]): string {
  const quoted = ids.map((id) => `"${id}"`).join(", ")
  return `${ids.length === 1 ? noun : `${noun}s`} ${quoted}`
}
