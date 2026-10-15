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
 * The two reads are not one snapshot, so they run in a fixed order: live keys first, tombstones
 * second. A delete or purge commits its tombstone in the same transaction that removes the row, so
 * a key whose row `keys.list()` no longer saw is always visible to the later `listAll()`; a key
 * deleted between the reads is still named from the live read. No key can fall out of both. The
 * labels feed the usage filter's owner/tool resolution as well as the names, so a key missing
 * from both would silently drop out of a filtered total.
 */
export function catalogLabels(deps: {
  readonly keys: Pick<ApiKeyRepository, "list">
  readonly tombstones: Pick<ApiKeyTombstoneRepository, "listAll">
  readonly catalog: Pick<RoutingCatalogStore, "accounts" | "pools">
}): () => Promise<UsageLabelSets> {
  return async () => {
    // Sequential on purpose: see the ordering note above.
    const live = await deps.keys.list()
    const stones = await deps.tombstones.listAll()
    const keys = new Map<string, KeyLabel>()
    // Tombstones first, so a live row wins if the two ever coexist (a delete racing a read).
    for (const row of [...stones, ...live]) {
      keys.set(row.id, {
        name: row.name,
        owner: row.owner,
        ownerKind: row.ownerKind,
        tool: row.tool,
        prefix: row.prefix,
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

/**
 * Account id to provider id, for the CSV export's `provider` column. Copies the one string off
 * each snapshot: a routable account also carries its encrypted auth material, and nothing but
 * this field may leave it. A deleted account has no entry, so its provider cell is empty.
 */
export function accountProviders(
  catalog: Pick<RoutingCatalogStore, "accounts">,
): () => ReadonlyMap<string, string> {
  return () => new Map(catalog.accounts().map((account) => [account.id, account.snapshot.provider]))
}
