import type { Database } from "../client"
import type { AccountRow } from "../schema/accounts"
import type { PoolMemberRow, PoolRow } from "../schema/pools"
import type { QuotaWindowRow } from "../schema/quota-windows"
import { createAccountRepository } from "./account-repository"
import { createPoolRepository } from "./pool-repository"

export interface CatalogSnapshotRows {
  readonly accounts: readonly AccountRow[]
  readonly pools: readonly PoolRow[]
  readonly members: readonly PoolMemberRow[]
  readonly windows: readonly QuotaWindowRow[]
}

export interface CatalogSnapshotRepository {
  read(): Promise<CatalogSnapshotRows>
}

/** A concurrent admin commit must not produce old pool metadata with new membership. */
export function createCatalogSnapshotRepository(db: Database): CatalogSnapshotRepository {
  return {
    read: () =>
      db.transaction(
        async (tx) => {
          const accounts = createAccountRepository(tx)
          const pools = createPoolRepository(tx)
          const [accountRows, poolRows] = await Promise.all([accounts.list(), pools.list()])
          const [members, windows] = await Promise.all([
            pools.listMembersForPools(poolRows.map((row) => row.id)),
            accounts.listQuotaWindows(accountRows.map((row) => row.id)),
          ])
          return { accounts: accountRows, pools: poolRows, members, windows }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
  }
}
