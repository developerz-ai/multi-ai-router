import type { QuotaWindowState } from "@multi-ai-router/core"
import {
  type AccountBreakerRow,
  type AccountRow,
  type CatalogSnapshotRepository,
  credentialFingerprint,
  type RecoveryRow,
} from "@multi-ai-router/db"
import {
  providerCarriesSession,
  providerModelFamily,
  providerRoutingVariants,
  providerUnderstandsContextTags,
} from "../../providers/registry"
import type { RoutableAccount } from "../dataplane"
import type { AccountSnapshot, ModelRemoval, PoolSnapshot } from "../routing"
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

/**
 * Which removals from `supported_models` the snapshot carries. Absent: every stored one — the
 * writer already prunes the column to `MODEL_REMOVAL_MEMORY_DAYS` on each write; with it, one that
 * aged out since the last write is dropped too.
 */
export interface RemovalMemory {
  readonly now: () => Date
  readonly memoryMs: number
}

export async function loadCatalog(
  sources: CatalogSources,
  removalMemory?: RemovalMemory,
): Promise<CatalogData> {
  // One repeatable-read snapshot: another replica may commit a complete pool edit between
  // statements, but this load must never combine its old policy with its new membership.
  const {
    accounts: accountRows,
    pools: poolRows,
    members,
    windows: windowRows,
    recoveries,
    breakers = [],
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
  const breakerByAccount = new Map(breakers.map((row) => [row.accountId, row]))
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
      toRoutableAccount(
        row,
        windowsByAccount.get(row.id),
        recoveryByAccount.get(row.id),
        removalHorizon(removalMemory),
        breakerByAccount.get(row.id),
      ),
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
  removedAfter: number,
  candidate?: AccountBreakerRow,
): RoutableAccount {
  const breaker =
    candidate !== undefined &&
    candidate.lifecycleVersion === row.lifecycleVersion &&
    candidate.healthRecoveryVersion === row.healthRecoveryVersion &&
    candidate.authRecoveryVersion === row.authRecoveryVersion &&
    candidate.credentialFingerprint === credentialFingerprint(row.authMaterial)
      ? candidate
      : undefined
  return {
    ...(breaker === undefined ? {} : { breaker }),
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
      ...removedModelsOf(row, removedAfter),
      ...(providerUnderstandsContextTags(row.provider) ? { understandsContextTags: true } : {}),
      ...routingVariantsOf(row),
      ...(providerCarriesSession(row.provider) ? { carriesSession: true } : {}),
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
      ...(row.providerPreferences === null ? {} : { providerPreferences: row.providerPreferences }),
    },
    billing: row.billing,
    authMaterial: row.authMaterial,
    configDir: row.configDir,
  }
}

function routingVariantsOf(row: AccountRow): Pick<AccountSnapshot, "routingVariants"> {
  const variants = providerRoutingVariants(row.provider)
  return variants.length === 0 ? {} : { routingVariants: variants }
}

function modelFamilyOf(row: AccountRow): Pick<AccountSnapshot, "modelFamily"> {
  const family = providerModelFamily(row.provider)
  return family === undefined ? {} : { modelFamily: family }
}

function removalHorizon(memory: RemovalMemory | undefined): number {
  return memory === undefined ? Number.NEGATIVE_INFINITY : memory.now().getTime() - memory.memoryMs
}

/** The removals still inside the window, keyed by id; absent when there are none. */
function removedModelsOf(
  row: AccountRow,
  removedAfter: number,
): Pick<AccountSnapshot, "removedModels"> {
  const removed = new Map<string, ModelRemoval>()
  for (const entry of row.supportedModelsRemoved ?? []) {
    const at = new Date(entry.removedAt)
    if (at.getTime() > removedAfter) removed.set(entry.model, { at, by: entry.by })
  }
  return removed.size === 0 ? {} : { removedModels: removed }
}
