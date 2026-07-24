/**
 * Step 1-2 of the chain: resolve the presenting key's scope, then intersect it with pool
 * membership.
 *
 *     candidates = pool_members ∩ key_scope
 *
 * Both must admit an account. No policy, no failover step, and no "everything else is down"
 * condition ever reaches outside the result — there is no setting that relaxes it. Because a key
 * scoped to two pools gets *each pool's own policy applied within that pool*, the output is a
 * list of groups, not one flat set: the policy never runs across the union.
 */

import { DEFAULT_ROUTING_POLICY } from "@multi-ai-router/core"
import type { ScopeDiagnostics } from "./result"
import type {
  AccountSnapshot,
  PoolSnapshot,
  RoutingSnapshot,
  ScopedAccount,
  ScopeGroup,
  SelectionOptions,
  SelectionRequest,
} from "./types"

export interface ScopeResolution {
  readonly groups: readonly ScopeGroup[]
  readonly diagnostics: ScopeDiagnostics
}

export function resolveScope(
  snapshot: RoutingSnapshot,
  request: SelectionRequest,
  options: SelectionOptions = {},
): ScopeResolution {
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]))
  const unresolved: string[] = []
  const groups = buildGroups(snapshot, request, options, accounts, unresolved)

  const inScope = new Set<string>()
  for (const group of groups) {
    for (const member of group.members) inScope.add(member.account.id)
    // The overflow member is in scope too — it is simply invisible to the policy until the
    // primary set filters empty.
    if (group.overflow !== null) inScope.add(group.overflow.account.id)
  }

  return {
    groups,
    diagnostics: {
      scope: request.keyScope,
      inScopeAccountIds: [...inScope],
      unresolvedTargetIds: unresolved,
    },
  }
}

function buildGroups(
  snapshot: RoutingSnapshot,
  request: SelectionRequest,
  options: SelectionOptions,
  accounts: ReadonlyMap<string, AccountSnapshot>,
  unresolved: string[],
): readonly ScopeGroup[] {
  const scope = request.keyScope
  const unpooled = options.unpooledPolicy ?? DEFAULT_ROUTING_POLICY
  const rotation = request.rotationCounter ?? 0

  if (scope.kind === "all") {
    // `all` skips pools entirely, so there is no pool policy to inherit.
    return [flatGroup(snapshot.accounts, unpooled, rotation)]
  }

  if (scope.kind === "accounts") {
    // An explicit account list ignores pool membership: that list *is* the candidate set.
    const members = resolveAccountList(scope.accountIds, accounts, unresolved)
    return [flatGroup(members, unpooled, rotation)]
  }

  const pools = new Map(snapshot.pools.map((pool) => [pool.id, pool]))
  const groups: ScopeGroup[] = []
  for (const poolId of scope.poolIds) {
    const pool = pools.get(poolId)
    if (pool === undefined) {
      unresolved.push(poolId)
      continue
    }
    groups.push(poolGroup(pool, accounts, unresolved, rotation))
  }
  return groups
}

function flatGroup(
  accounts: readonly AccountSnapshot[],
  policy: ScopeGroup["policy"],
  rotationCounter: number,
): ScopeGroup {
  return {
    poolId: null,
    poolName: null,
    policy,
    rotationCounter,
    members: accounts.map((account, order) => scoped(account, null, order)),
    overflow: null,
  }
}

function poolGroup(
  pool: PoolSnapshot,
  accounts: ReadonlyMap<string, AccountSnapshot>,
  unresolved: string[],
  fallbackRotation: number,
): ScopeGroup {
  const members: ScopedAccount[] = []
  for (const membership of pool.members) {
    const account = accounts.get(membership.accountId)
    if (account === undefined) {
      unresolved.push(membership.accountId)
      continue
    }
    members.push({
      account,
      poolId: pool.id,
      weight: membership.weight ?? account.weight,
      priority: membership.priority ?? account.priority,
      order: members.length,
    })
  }

  return {
    poolId: pool.id,
    poolName: pool.name,
    policy: pool.policy,
    rotationCounter: pool.rotationCounter ?? fallbackRotation,
    members,
    overflow: resolveOverflow(pool, accounts, members.length),
  }
}

/**
 * The pool's member of last resort. It is scoped by the pool that designates it, so a key scoped
 * to that pool may reach it — and a key scoped to explicit accounts never does, because such a
 * key has no pool group at all.
 */
function resolveOverflow(
  pool: PoolSnapshot,
  accounts: ReadonlyMap<string, AccountSnapshot>,
  order: number,
): ScopedAccount | null {
  if (pool.overflowAccountId === undefined) return null
  const account = accounts.get(pool.overflowAccountId)
  if (account === undefined) return null
  return scoped(account, pool.id, order)
}

function resolveAccountList(
  accountIds: readonly string[],
  accounts: ReadonlyMap<string, AccountSnapshot>,
  unresolved: string[],
): readonly AccountSnapshot[] {
  const resolved: AccountSnapshot[] = []
  for (const accountId of accountIds) {
    const account = accounts.get(accountId)
    if (account === undefined) {
      unresolved.push(accountId)
      continue
    }
    resolved.push(account)
  }
  return resolved
}

function scoped(account: AccountSnapshot, poolId: string | null, order: number): ScopedAccount {
  return { account, poolId, weight: account.weight, priority: account.priority, order }
}

/** True when the account is admitted by the scope. The one question every other layer asks. */
export function isInScope(resolution: ScopeResolution, accountId: string): boolean {
  return resolution.diagnostics.inScopeAccountIds.includes(accountId)
}
