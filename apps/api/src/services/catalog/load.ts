import type { AccountRepository, AccountRow, PoolRepository } from "@multi-ai-router/db"
import type { RoutableAccount } from "../dataplane"
import type { PoolSnapshot } from "../routing"

/**
 * Reads the world out of Postgres and shapes it into what routing consumes.
 *
 * This runs at boot, on a timer, and after an admin write — never on a request.
 * The result is handed to the warm catalog, which is what the data plane reads
 * (docs/idea/01-architecture.md, performance budget).
 */

export interface CatalogSources {
  readonly accounts: Pick<AccountRepository, "list">
  readonly pools: Pick<PoolRepository, "list" | "listMembersForPools">
}

export interface CatalogData {
  readonly accounts: readonly RoutableAccount[]
  readonly pools: readonly PoolSnapshot[]
}

export async function loadCatalog(sources: CatalogSources): Promise<CatalogData> {
  // Two queries, not one per pool: membership for every pool arrives in a single
  // statement. A refresh is off the request path but still runs on a timer.
  const [accountRows, poolRows] = await Promise.all([
    sources.accounts.list({}),
    sources.pools.list(),
  ])
  const members = await sources.pools.listMembersForPools(poolRows.map((pool) => pool.id))

  const membersByPool = new Map<string, { accountId: string; weight: number; priority: number }[]>()
  for (const member of members) {
    const bucket = membersByPool.get(member.poolId) ?? []
    bucket.push({
      accountId: member.accountId,
      weight: member.weight,
      priority: member.priority,
    })
    membersByPool.set(member.poolId, bucket)
  }

  return {
    accounts: accountRows.map(toRoutableAccount),
    pools: poolRows.map((pool) => ({
      id: pool.id,
      name: pool.name,
      policy: pool.policy,
      members: membersByPool.get(pool.id) ?? [],
      ...(pool.overflowAccountId === null ? {} : { overflowAccountId: pool.overflowAccountId }),
    })),
  }
}

/**
 * Disabled accounts are included deliberately: filtering is routing's job, and a
 * catalog that hides them makes "why did nothing match" unanswerable. `status`
 * and `health` are overlaid per request from the in-memory health store, so the
 * value here is the operator's setting, not the live observation.
 */
function toRoutableAccount(row: AccountRow): RoutableAccount {
  return {
    id: row.id,
    snapshot: {
      id: row.id,
      label: row.label,
      provider: row.provider,
      status: row.status,
      weight: row.weight,
      priority: row.priority,
      health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
      ...(row.modelAliases === null ? {} : { modelAliases: row.modelAliases }),
    },
    driver: {
      id: row.id,
      provider: row.provider,
      baseUrl: row.baseUrl,
      dialect: row.dialect,
      modelAliases: row.modelAliases,
    },
    authMaterial: row.authMaterial,
    configDir: row.configDir,
  }
}
