import {
  createAccountRepository,
  createAdminCredentialRepository,
  createApiKeyRepository,
  createApiKeyTombstoneRepository,
  createAuditRepository,
  createCredentialRefreshLockPool,
  createModelCatalogRepository,
  createOauthStateRepository,
  createPoolRepository,
  createPriceOverrideRepository,
  createScheduledTaskRepository,
  createSchedulerLockPool,
  createSdkSessionClaimLockPool,
  createSessionRepository,
  createUsageHistoryRepository,
  createUsageRecordRepository,
  createUsageReportRepository,
} from "@multi-ai-router/db"

import type { RuntimeDeps } from "./runtime-types"
export interface RuntimeRepositories {
  readonly refreshLock: ReturnType<typeof createCredentialRefreshLockPool>
  readonly schedulerLock: ReturnType<typeof createSchedulerLockPool>
  /** Fleet-wide SDK session-claim gate. One turn at a time per conversation across replicas. */
  readonly sdkSessionClaimLock: ReturnType<typeof createSdkSessionClaimLockPool>
  readonly accounts: ReturnType<typeof createAccountRepository>
  readonly keys: ReturnType<typeof createApiKeyRepository>
  readonly keyTombstones: ReturnType<typeof createApiKeyTombstoneRepository>
  readonly pools: ReturnType<typeof createPoolRepository>
  readonly auditEvents: ReturnType<typeof createAuditRepository>
  readonly usageRecords: ReturnType<typeof createUsageRecordRepository>
  readonly priceOverrides: ReturnType<typeof createPriceOverrideRepository>
  readonly sessions: ReturnType<typeof createSessionRepository>
  readonly oauthStates: ReturnType<typeof createOauthStateRepository>
  readonly adminCredentials: ReturnType<typeof createAdminCredentialRepository>
  readonly usageHistory: ReturnType<typeof createUsageHistoryRepository>
  readonly usageReports: ReturnType<typeof createUsageReportRepository>
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
  // The pool reserves a connection per held turn and is shut down with the other pools. Its keys
  // come from the same FNV derivation as `advisoryLockKey`, so every replica contends identically.
  // A resume holds two advisory leases at once (conversation plus account-scoped SDK key), so it
  // needs at least two sessions; the pool clamps the scheduler budget to that minimum.
  const sdkSessionClaimLock = createSdkSessionClaimLockPool({
    url: env.databaseUrl,
    // Bounded: a claim is at most two reserved connections, and this pool must never starve the
    // main DB. The scheduler's default of one is not enough for a resume.
    maxConnections: env.scheduler.lockPoolMaxConnections,
    connectTimeoutSeconds: env.databasePool.connectTimeoutSeconds,
    closeTimeoutSeconds: env.databasePool.closeTimeoutSeconds,
  })
  const accounts = createAccountRepository(database, {
    recoveryCooldownMs: env.recovery.cooldownMs,
    lastUsedMinIntervalMs: env.accountLastUsedStampIntervalSeconds * 1_000,
  })
  const keys = createApiKeyRepository(database)
  const keyTombstones = createApiKeyTombstoneRepository(database)
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
  // Stored weekly usage reports: written by the report task, swept by the janitor.
  const usageReports = createUsageReportRepository(database)
  // The scheduler's run log records bounded maintenance outcomes.
  const scheduledTasks = createScheduledTaskRepository(database)
  // What each account's upstream says it serves, and how big. A *description* — the hourly sweep
  // writes it and nothing in selection reads it, which is what lets it refresh on a timer at all
  // while `accounts.supported_models` deliberately does not.
  const modelCatalog = createModelCatalogRepository(database)

  return {
    refreshLock,
    schedulerLock,
    sdkSessionClaimLock,
    accounts,
    keys,
    keyTombstones,
    pools,
    auditEvents,
    usageRecords,
    priceOverrides,
    sessions,
    oauthStates,
    adminCredentials,
    usageHistory,
    usageReports,
    scheduledTasks,
    modelCatalog,
  }
}
