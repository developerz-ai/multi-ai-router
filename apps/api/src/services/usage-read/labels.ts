import type { ApiKeyRepository } from "@multi-ai-router/db"
import type { RoutingCatalogStore } from "../catalog"
import type { UsageLabelSets } from "./service"

/**
 * Naming the subjects of a usage report, from what the router already has.
 *
 * Accounts and pools come from the warm catalog, so the two axes an operator filters on cost
 * nothing; keys need the one query, which is unremarkable on the admin plane and is why this is not
 * a third cache. A miss is not an error — spend that happened is still spend, and a deleted subject
 * keeps its totals under its id.
 */
export function catalogLabels(deps: {
  readonly keys: Pick<ApiKeyRepository, "list">
  readonly catalog: Pick<RoutingCatalogStore, "accounts" | "pools">
}): () => Promise<UsageLabelSets> {
  return async () => ({
    keys: new Map((await deps.keys.list()).map((key) => [key.id, key.name])),
    accounts: new Map(
      deps.catalog.accounts().map((account) => [account.id, account.snapshot.label]),
    ),
    pools: new Map(deps.catalog.pools().map((pool) => [pool.id, pool.name])),
  })
}
