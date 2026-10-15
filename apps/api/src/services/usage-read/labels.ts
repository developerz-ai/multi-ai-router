import type { ApiKeyRepository, ApiKeyTombstoneRepository } from "@multi-ai-router/db"
import type { RoutingCatalogStore } from "../catalog"
import type { KeyLabel, UsageLabelSets } from "./service"

/**
 * Naming the subjects of a usage report, from what the router already has.
 *
 * Accounts and pools come from the warm catalog, so the two axes an operator filters on cost
 * nothing; keys need two queries, which is unremarkable on the admin plane and is why this is not
 * a third cache. A miss is not an error — spend that happened is still spend, and a subject with
 * no name anywhere keeps its totals under its id.
 *
 * A key is named by its live row, else by the tombstone its purge or delete left behind (the
 * rollups outlive the row). Tombstones are read through their own method and merged here, never
 * unioned into `keys.list()`: that list is the admin keys list, which must not show a purged key.
 *
 * The two reads are not one snapshot. A delete committing between them removes the row after
 * `keys.list()` saw it, so for that one load the key is still named from the live read; a delete
 * committing the other way round (row read as gone, tombstone read before the commit lands) shows
 * a transient "deleted" for that key until the next load. Neither is worse than the label being
 * decoration, so it is not worth a transaction.
 */
export function catalogLabels(deps: {
  readonly keys: Pick<ApiKeyRepository, "list">
  readonly tombstones: Pick<ApiKeyTombstoneRepository, "listAll">
  readonly catalog: Pick<RoutingCatalogStore, "accounts" | "pools">
}): () => Promise<UsageLabelSets> {
  return async () => {
    const [live, stones] = await Promise.all([deps.keys.list(), deps.tombstones.listAll()])
    const keys = new Map<string, KeyLabel>()
    // Tombstones first, so a live row wins if the two ever coexist (a delete racing a read).
    for (const row of [...stones, ...live]) {
      keys.set(row.id, {
        name: row.name,
        owner: row.owner,
        ownerKind: row.ownerKind,
        tool: row.tool,
      })
    }
    return {
      keys,
      accounts: new Map(
        deps.catalog.accounts().map((account) => [account.id, account.snapshot.label]),
      ),
      pools: new Map(deps.catalog.pools().map((pool) => [pool.id, pool.name])),
    }
  }
}
