import type { ApiKeyRepository } from "@multi-ai-router/db"
import type { KeyScopeTargets } from "./view"

export async function readKeyTargets(
  keys: Pick<ApiKeyRepository, "listPoolTargets" | "listAccountTargets">,
  id: string,
): Promise<KeyScopeTargets> {
  return {
    poolIds: (await keys.listPoolTargets(id)).map((row) => row.poolId),
    accountIds: (await keys.listAccountTargets(id)).map((row) => row.accountId),
  }
}
