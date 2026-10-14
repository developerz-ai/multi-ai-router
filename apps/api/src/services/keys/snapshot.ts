import type { ApiKeyRepository } from "@multi-ai-router/db"
import type { KeyScopeTargets } from "./view"

export async function readKeyTargets(
  keys: Pick<ApiKeyRepository, "listPoolTargets" | "listAccountTargets">,
  id: string,
): Promise<KeyScopeTargets> {
  // Row order is the scope's listed order (`api_key_pools.position`) — keep it
  // through every mapping below. Nothing between here and the view may sort:
  // a key's primary pool must render, and route, first.
  return {
    poolIds: (await keys.listPoolTargets(id)).map((row) => row.poolId),
    accountIds: (await keys.listAccountTargets(id)).map((row) => row.accountId),
  }
}
