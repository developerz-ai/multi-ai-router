import {
  createAccountRepository,
  createAdminCredentialRepository,
  createApiKeyRepository,
  createAuditRepository,
  createCredentialRefreshLockPool,
  createModelCatalogRepository,
  createOauthStateRepository,
  createPoolRepository,
  createPriceOverrideRepository,
  createScheduledTaskRepository,
  createSchedulerLockPool,
  createSessionRepository,
  createUsageHistoryRepository,
  createUsageRecordRepository,
} from "@multi-ai-router/db"

import type { RuntimeDeps } from "./runtime-types"
export interface RuntimeRepositories {
  readonly refreshLock: ReturnType<typeof createCredentialRefreshLockPool>
  readonly schedulerLock: ReturnType<typeof createSchedulerLockPool>
  readonly accounts: ReturnType<typeof createAccountRepository>
  readonly keys: ReturnType<typeof createApiKeyRepository>
  readonly pools: ReturnType<typeof createPoolRepository>
  readonly auditEvents: ReturnType<typeof createAuditRepository>
  readonly usageRecords: ReturnType<typeof createUsageRecordRepository>
  readonly priceOverrides: ReturnType<typeof createPriceOverrideRepository>
  readonly sessions: ReturnType<typeof createSessionRepository>
  readonly oauthStates: ReturnType<typeof createOauthStateRepository>
  readonly adminCredentials: ReturnType<typeof createAdminCredentialRepository>
  readonly usageHistory: ReturnType<typeof createUsageHistoryRepository>
  readonly scheduledTasks: ReturnType<typeof createScheduledTaskRepository>
  readonly modelCatalog: ReturnType<typeof createModelCatalogRepository>
}

export function createRuntimeRepositories(deps: RuntimeDeps): RuntimeRepositories {
  const { env, database } = deps
  const refreshLock = createCredentialRefreshLockPool({
    url: env.databaseUrl,
    maxConnections: env.oauthRefresh.lockPoolMaxConnections,
    connectTimeoutSeconds: env.databasePool.connectTimeoutSeconds,
    closeTimeoutSeconds: env.databasePool.closeTimeoutSeconds,
  })
  const schedulerLock = createSchedulerLockPool({
    url: env.databaseUrl,
    maxConnections: env.scheduler.lockPoolMaxConnections,
    connectTimeoutSeconds: env.databasePool.connectTimeoutSeconds,
    closeTimeoutSeconds: env.databasePool.closeTimeoutSeconds,
  })
  const accounts = createAccountRepository(database, {
    recoveryCooldownMs: env.recovery.cooldownMs,
  })
  const keys = createApiKeyRepository(database)
  const pools = createPoolRepository(database)
  const auditEvents = createAuditRepository(database)
  const usageRecords = createUsageRecordRepository(database)
  // Operator-edited prices. Read at boot into the warm book below, never on the request path.
  const priceOverrides = createPriceOverrideRepository(database)
  // Conversation identity: written by the data plane's session store, swept by the janitor.
  const sessions = createSessionRepository(database)
  const oauthStates = createOauthStateRepository(database)
  // The one-row local admin credential. The auth service reads it live, so a
  // `bin/admin` verb takes effect without a restart.
  const adminCredentials = createAdminCredentialRepository(database)
  // Receipt-admitted event history and bounded migration/retention share one repository.
  const usageHistory = createUsageHistoryRepository(database)
  // The scheduler's run log records bounded maintenance outcomes.
  const scheduledTasks = createScheduledTaskRepository(database)
  // What each account's upstream says it serves, and how big. A *description* — the hourly sweep
  // writes it and nothing in selection reads it, which is what lets it refresh on a timer at all
  // while `accounts.supported_models` deliberately does not.
  const modelCatalog = createModelCatalogRepository(database)

  return {
    refreshLock,
    schedulerLock,
    accounts,
    keys,
    pools,
    auditEvents,
    usageRecords,
    priceOverrides,
    sessions,
    oauthStates,
    adminCredentials,
    usageHistory,
    scheduledTasks,
    modelCatalog,
  }
}
