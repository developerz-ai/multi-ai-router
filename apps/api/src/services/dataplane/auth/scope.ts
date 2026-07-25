import type { KeyScope } from "@multi-ai-router/core"
import type { ApiKeyRow } from "@multi-ai-router/db"
import type { KeyScopeSnapshot } from "../../routing"

/**
 * A key's stored scope, turned into the snapshot routing selection reads.
 *
 * Scope is enforced as an **intersection** — `candidates = pool_members ∩ key_scope` — and is
 * never widened by a policy, a failover step, or an "everything else is down" condition
 * (docs/idea/04-api-keys-and-access.md#how-scope-is-enforced). This module only shapes the input;
 * `services/routing/scope.ts` does the intersecting.
 *
 * The targets are loaded rather than read from the row because `api_key_pools` and
 * `api_key_accounts` are separate tables and `packages/db` owns their SQL. The loader runs on a
 * cache **miss** only, so the hot path never sees it.
 */

export interface KeyScopeTargets {
  readonly poolIds: readonly string[]
  readonly accountIds: readonly string[]
}

export const NO_TARGETS: KeyScopeTargets = { poolIds: [], accountIds: [] }

export function keyScopeSnapshot(scope: KeyScope, targets: KeyScopeTargets): KeyScopeSnapshot {
  if (scope === "pools") return { kind: "pools", poolIds: [...targets.poolIds] }
  if (scope === "accounts") return { kind: "accounts", accountIds: [...targets.accountIds] }
  return { kind: "all" }
}

/** Resolves one key's scope. Called on a verification cache miss, never per request. */
export type KeyScopeLoader = (row: ApiKeyRow) => Promise<KeyScopeSnapshot>

/**
 * The ordinary loader: read the key's scope targets, shape them. Supplied with a repository
 * lookup by whoever wires the app, so this layer never learns what a table is.
 */
export function createScopeLoader(
  loadTargets: (apiKeyId: string) => Promise<KeyScopeTargets>,
): KeyScopeLoader {
  return async (row) => {
    if (row.scope === "all") return { kind: "all" }
    return keyScopeSnapshot(row.scope, await loadTargets(row.id))
  }
}

/**
 * The two membership queries a scoped key's targets come from. Structural rather than the
 * repository's own type, so this layer still never learns what a table is.
 */
export interface KeyTargetSource {
  listPoolTargets(apiKeyId: string): Promise<readonly { readonly poolId: string }[]>
  listAccountTargets(apiKeyId: string): Promise<readonly { readonly accountId: string }[]>
}

/** The production loader: both membership queries in parallel, shaped into a scope snapshot. */
export function repositoryScopeLoader(source: KeyTargetSource): KeyScopeLoader {
  return createScopeLoader(async (apiKeyId) => {
    const [pools, accounts] = await Promise.all([
      source.listPoolTargets(apiKeyId),
      source.listAccountTargets(apiKeyId),
    ])
    return {
      poolIds: pools.map((row) => row.poolId),
      accountIds: accounts.map((row) => row.accountId),
    }
  })
}

/**
 * A loader for a deployment with no scoped keys yet: `all` passes, and a key that *claims* a
 * limited scope resolves to an **empty** target set rather than to `all`. Failing closed is the
 * only safe direction — widening a scope because its targets could not be loaded is precisely the
 * silent widening the spec forbids.
 */
export const unscopedLoader: KeyScopeLoader = (row) =>
  Promise.resolve(keyScopeSnapshot(row.scope, NO_TARGETS))
