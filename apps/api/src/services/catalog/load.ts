import type { QuotaWindowState } from "@multi-ai-router/core"
import type { AccountRow, CatalogSnapshotRepository, RecoveryRow } from "@multi-ai-router/db"
import { providerModelFamily, providerUnderstandsContextTags } from "../../providers/registry"
import type { RoutableAccount } from "../dataplane"
import type { AccountSnapshot, PoolSnapshot } from "../routing"
import { toQuotaEvidence } from "../routing/quota-evidence"

/**
 * Reads the world out of Postgres and shapes it into what routing consumes.
 *
 * This runs at boot, on a timer, and after an admin write — never on a request.
 * The result is handed to the warm catalog, which is what the data plane reads
 * (docs/idea/01-architecture.md, performance budget).
 */

export type CatalogSources = Pick<CatalogSnapshotRepository, "read">

export interface CatalogData {
  readonly accounts: readonly RoutableAccount[]
  readonly pools: readonly PoolSnapshot[]
}

export async function loadCatalog(sources: CatalogSources): Promise<CatalogData> {
  // One repeatable-read snapshot: another replica may commit a complete pool edit between
  // statements, but this load must never combine its old policy with its new membership.
  const {
    accounts: accountRows,
    pools: poolRows,
    members,
    windows: windowRows,
    recoveries,
  } = await sources.read()

  // Quota state is durable and routing reads it per request, so it is hydrated
  // here rather than queried: `findSpentWindow` and `continuousHeadroom`
  // (`services/routing/quota.ts`) run against this snapshot, on the request
  // path, where a query is not allowed. An account with no rows keeps
  // `quotaWindows` absent — routing reads absent as *unknown*, and an empty
  // array would be the different and wrong claim that we looked and there was
  // nothing to report.
  const windowsByAccount = new Map<string, QuotaWindowState[]>()
  for (const row of windowRows) {
    const bucket = windowsByAccount.get(row.accountId) ?? []
    bucket.push(toQuotaEvidence(row))
    windowsByAccount.set(row.accountId, bucket)
  }

  const recoveryByAccount = new Map(recoveries.map((row) => [row.accountId, row]))
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
    accounts: accountRows.map((row) =>
      toRoutableAccount(row, windowsByAccount.get(row.id), recoveryByAccount.get(row.id)),
    ),
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
function toRoutableAccount(
  row: AccountRow,
  quotaWindows: readonly QuotaWindowState[] | undefined,
  recovery: RecoveryRow | undefined,
): RoutableAccount {
  return {
    id: row.id,
    ...(recovery === undefined ? {} : { recovery }),
    lifecycleVersion: row.lifecycleVersion,
    healthRecoveryVersion: row.healthRecoveryVersion,
    authRecoveryVersion: row.authRecoveryVersion,
    snapshot: {
      id: row.id,
      label: row.label,
      provider: row.provider,
      status: row.status,
      weight: row.weight,
      priority: row.priority,
      health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
      ...(row.modelAliases === null ? {} : { modelAliases: row.modelAliases }),
      // An empty list is dropped rather than carried: routing reads absent as *unknown* and acts
      // on a present one, so `[]` would be the different and wrong claim that this account
      // supports no model at all — every request for it a 503, and nothing in `/v1/models`.
      // A discovery that came back with nothing must not silently take an account offline.
      ...(row.supportedModels === null || row.supportedModels.length === 0
        ? {}
        : { supportedModels: row.supportedModels }),
      // The provider's default family narrows an undeclared subscription to its vendor's names; an
      // explicit list above replaces it (`services/routing/model-family.ts`).
      ...modelFamilyOf(row),
      ...(providerUnderstandsContextTags(row.provider) ? { understandsContextTags: true } : {}),
      ...(quotaWindows === undefined ? {} : { quotaWindows }),
      ...(recovery === undefined
        ? {}
        : {
            recovery: {
              revision: recovery.revision,
              generation: recovery.generation,
              lifecycleVersion: recovery.lifecycleVersion,
              state: recovery.state,
              nextAllowedAt: recovery.nextAllowedAt,
              quotaRevisions: { ...recovery.quotaRevisions },
            },
          }),
    },
    driver: {
      id: row.id,
      provider: row.provider,
      baseUrl: row.baseUrl,
      dialect: row.dialect,
      modelAliases: row.modelAliases,
    },
    billing: row.billing,
    authMaterial: row.authMaterial,
    configDir: row.configDir,
  }
}

function modelFamilyOf(row: AccountRow): Pick<AccountSnapshot, "modelFamily"> {
  const family = providerModelFamily(row.provider)
  return family === undefined ? {} : { modelFamily: family }
}
