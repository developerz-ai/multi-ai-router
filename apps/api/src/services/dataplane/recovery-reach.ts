import type { ApiKeyRepository, ApiKeyRow } from "@multi-ai-router/db"
import type { PoolSnapshot } from "../routing"

/** Every account, or exactly these: what some usable router key can route to. */
export type Reach = "all" | ReadonlySet<string>

type ScopeTargetRows = Awaited<ReturnType<ApiKeyRepository["listTargetsForKeys"]>>
type ReachKey = Pick<ApiKeyRow, "id" | "scope" | "revoked" | "expiresAt">

function usable(key: ReachKey, now: Date): boolean {
  return !key.revoked && (key.expiresAt === null || key.expiresAt.getTime() > now.getTime())
}

/**
 * The accounts a usable key's scope resolves to (`routing/scope.ts`): an `all` key reaches every
 * account, a `pools` key the members of its pools, an `accounts` key its list. An account outside
 * every usable key's reach serves nobody, so the router's recovery probe has nothing to restore.
 */
export function reachableAccounts(
  keys: readonly ReachKey[],
  targets: ScopeTargetRows,
  pools: readonly PoolSnapshot[],
  now: Date,
): Reach {
  const live = keys.filter((key) => usable(key, now))
  if (live.some((key) => key.scope === "all")) return "all"
  const ids = new Set(live.map((key) => key.id))
  const reached = new Set<string>()
  for (const row of targets.accounts) if (ids.has(row.apiKeyId)) reached.add(row.accountId)
  const poolIds = new Set(
    targets.pools.filter((row) => ids.has(row.apiKeyId)).map((row) => row.poolId),
  )
  for (const pool of pools) {
    if (!poolIds.has(pool.id)) continue
    for (const member of pool.members) reached.add(member.accountId)
  }
  return reached
}

/**
 * Read off-path, only when an account is due a reopen, and held for `ttlMs` (the catalog's own
 * staleness bound) so an unreachable account does not cost a query every coordinator tick.
 */
export function createReachability(deps: {
  readonly keys: Pick<ApiKeyRepository, "list" | "listTargetsForKeys">
  readonly pools: () => readonly PoolSnapshot[]
  readonly now: () => Date
  readonly ttlMs: number
}) {
  let held: { readonly at: number; readonly reach: Reach } | undefined
  return async (): Promise<Reach> => {
    const now = deps.now()
    if (held !== undefined && now.getTime() - held.at < deps.ttlMs) return held.reach
    const keys = (await deps.keys.list()).filter((key) => usable(key, now))
    const scoped = keys.filter((key) => key.scope !== "all").map((key) => key.id)
    const targets = await deps.keys.listTargetsForKeys(scoped)
    const reach = reachableAccounts(keys, targets, deps.pools(), now)
    held = { at: now.getTime(), reach }
    return reach
  }
}
