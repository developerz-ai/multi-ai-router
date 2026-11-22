/**
 * `@multi-ai-router/db`: the only module that knows SQL. Public surface: schema, connection
 * factory, migration runner, repositories.
 */

export { type AdvisoryLockRun, advisoryLockKey } from "./advisory-lock"
export type {
  Database,
  DatabaseExecutor,
  DatabaseHandle,
  DatabaseOptions,
  SqlConnection,
} from "./client"
export { createDatabase, DATABASE_POOL_DEFAULTS } from "./client"
export type {
  CredentialRefreshLease,
  CredentialRefreshLeaseResult,
  CredentialRefreshLock,
  CredentialRefreshLockPoolHandle,
  CredentialRefreshLockPoolOptions,
  CredentialRefreshLockResult,
} from "./credential-refresh-lock"
export { createCredentialRefreshLockPool } from "./credential-refresh-lock"
export type { MigrateOptions } from "./migrate"
export {
  defaultMigrationsFolder,
  MigrationLockTimeoutError,
  MigrationPreconditionError,
  runMigrations,
} from "./migrate"
export type { PoolSample } from "./pool-metrics"
export type {
  AccountBreakerRepository,
  BreakerObservation,
  ProbeHoldObservation,
} from "./repositories/account-breaker"
export { createAccountBreakerRepository } from "./repositories/account-breaker"
export type {
  AccountAuthorizationMethods,
  AccountLifecycleMethods,
  AccountObservation,
} from "./repositories/account-lifecycle-types"
export { credentialFingerprint } from "./repositories/account-recovery-common"
export { createRecoveryRepository } from "./repositories/account-recovery-repository"
export type { RecoveryRepository } from "./repositories/account-recovery-types"
export type {
  AccountReplicaLeaseRepository,
  ReplicaLeaseToken,
} from "./repositories/account-replica-lease-repository"
export { createAccountReplicaLeaseRepository } from "./repositories/account-replica-lease-repository"
export type {
  AccountListFilter,
  AccountRepository,
  AccountRepositoryOptions,
  AccountSummaryRow,
  CreateAccountInput,
} from "./repositories/account-repository"
export {
  ACCOUNT_LAST_USED_MIN_INTERVAL_DEFAULT_MS,
  createAccountRepository,
} from "./repositories/account-repository"
export type {
  AdminCredentialRepository,
  UpsertAdminCredentialInput,
} from "./repositories/admin-credential-repository"
export {
  ADMIN_CREDENTIAL_SINGLETON,
  createAdminCredentialRepository,
} from "./repositories/admin-credential-repository"
export type {
  LoginThrottleDecision,
  LoginThrottleNamespace,
  LoginThrottlePolicy,
} from "./repositories/admin-login-throttle-repository"
export { createAdminLoginThrottleRepository } from "./repositories/admin-login-throttle-repository"
export { AdminMutationConflictError } from "./repositories/admin-mutation-conflict"
export type {
  AdminMutationRepository,
  AdminMutationScope,
  AdminMutationSubject,
} from "./repositories/admin-mutation-repository"
export { createAdminMutationRepository } from "./repositories/admin-mutation-repository"
export type { AdminSessionRepository } from "./repositories/admin-session-repository"
export { createAdminSessionRepository } from "./repositories/admin-session-repository"
export type {
  ApiKeyListRow,
  ApiKeyRepository,
  ApiKeyWithTargets,
} from "./repositories/api-key-repository"
export { ApiKeyNameTakenError, createApiKeyRepository } from "./repositories/api-key-repository"
export type { ApiKeyTombstoneRepository } from "./repositories/api-key-tombstone-repository"
export { createApiKeyTombstoneRepository } from "./repositories/api-key-tombstone-repository"
export type {
  AppendAuditEventInput,
  AuditListFilter,
  AuditRepository,
  LatestForSubjectsInput,
  SubjectEventInstant,
} from "./repositories/audit-repository"
export { createAuditRepository } from "./repositories/audit-repository"
export type { BackgroundAccountSubject } from "./repositories/background-account-eligibility"
export type {
  CatalogSnapshotRepository,
  CatalogSnapshotRows,
} from "./repositories/catalog-snapshot-repository"
export { createCatalogSnapshotRepository } from "./repositories/catalog-snapshot-repository"
export type {
  ExhaustedWatchRepository,
  ExhaustedWatchRow,
  ExhaustedWatchState,
} from "./repositories/exhausted-watch-repository"
export { createExhaustedWatchRepository } from "./repositories/exhausted-watch-repository"
export type {
  AccountCatalogAge,
  AccountCatalogAttempt,
  ModelCatalogEntry,
  ModelCatalogRepository,
} from "./repositories/model-catalog-repository"
export { createModelCatalogRepository } from "./repositories/model-catalog-repository"
export type {
  CreateOauthStateInput,
  OauthStateRepository,
} from "./repositories/oauth-state-repository"
export { createOauthStateRepository } from "./repositories/oauth-state-repository"
export type {
  AccountQuotaObservation,
  ObservedQuotaWindowWrite,
} from "./repositories/observed-quota-window"
export type {
  PendingClaudeLoginRepository,
  PendingClaudeLoginToken,
} from "./repositories/pending-claude-login-repository"
export { createPendingClaudeLoginRepository } from "./repositories/pending-claude-login-repository"
export type {
  CreatePoolInput,
  PoolMemberInput,
  PoolRepository,
  UpdatePoolInput,
} from "./repositories/pool-repository"
export { createPoolRepository } from "./repositories/pool-repository"
export type {
  PriceOverrideInput,
  PriceOverrideRepository,
} from "./repositories/price-override-repository"
export {
  createPriceOverrideRepository,
  PriceOverrideAccountConflict,
} from "./repositories/price-override-repository"
export type { QuotaWindowWrite } from "./repositories/quota-window-mutations"
export type {
  FinishScheduledTaskInput,
  ScheduledTaskLatest,
  ScheduledTaskName,
  ScheduledTaskOutcome,
  ScheduledTaskRepository,
} from "./repositories/scheduled-task-repository"
export { createScheduledTaskRepository } from "./repositories/scheduled-task-repository"
export type { SessionRepository, UpsertSessionInput } from "./repositories/session-repository"
export { createSessionRepository } from "./repositories/session-repository"
export type { UsageBatchInsert, UsageBatchResult } from "./repositories/usage-batch-mutation"
export {
  UsageHistoryExpired,
  UsageIdentityConflict,
} from "./repositories/usage-contribution-values"
export type {
  UsageDailyGroupRow,
  UsageDailyRepository,
  UsageDayRange,
} from "./repositories/usage-daily-repository"
export {
  createUsageDailyRepository,
  startOfNextUtcDay,
  startOfUtcDay,
  toUtcDay,
} from "./repositories/usage-daily-repository"
export type { UsageExportRow } from "./repositories/usage-export-repository"
export type { UsageHistoryRepositoryOptions } from "./repositories/usage-history-repository"
export { createUsageHistoryRepository } from "./repositories/usage-history-repository"
export type { UsageSummaryAggregates } from "./repositories/usage-history-summary"
export type {
  UsageHistoryCoverage,
  UsageHistoryRepository,
} from "./repositories/usage-history-types"
export type {
  TokenSpanShape,
  TokenSpanUsage,
  UsageAttributedDimension,
  UsageColumnDimension,
  UsageDimension,
  UsageFilter,
  UsageGroupRow,
  UsageGroupSeriesPoint,
  UsageKeyAttribution,
  UsageLatency,
  UsageOutcomeCount,
  UsageRawGroupRow,
  UsageRawTotals,
  UsageReadRepository,
  UsageSeriesPoint,
  UsageTotals,
  UsageWindow,
} from "./repositories/usage-read-repository"
export { createUsageReadRepository, foldTokenSpans } from "./repositories/usage-read-repository"
export type {
  RecentAttemptQuery,
  RecentAttemptRow,
  UsageRecentRepository,
} from "./repositories/usage-recent-repository"
export { createUsageRecentRepository } from "./repositories/usage-recent-repository"
export type {
  NewUsageReport,
  UsageReportRepository,
  UsageReportSummary,
} from "./repositories/usage-report-repository"
export { createUsageReportRepository } from "./repositories/usage-report-repository"
export type { UsageRecordInsert, UsageRecordRepository } from "./repositories/usage-repository"
export {
  createUsageRecordRepository,
  PG_MAX_BIND_PARAMETERS,
  USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
  USAGE_RECORD_MAX_BATCH_ROWS,
} from "./repositories/usage-repository"
export type { UsageWeekRead, UsageWeekRow } from "./repositories/usage-week-read"
export { UsageWeekRowCeilingError } from "./repositories/usage-week-read"
export type { SchedulerLockPoolHandle, SchedulerLockPoolOptions } from "./scheduler-lock"
export { createSchedulerLockPool } from "./scheduler-lock"
export { type AccountBreakerRow, accountBreakers } from "./schema/account-breakers"
export type { RecoveryReason, RecoveryRow, RecoveryState } from "./schema/account-recoveries"
export { accountRecoveries } from "./schema/account-recoveries"
export type { AccountReplicaLeaseRow, ReplicaLeaseState } from "./schema/account-replica-leases"
export type {
  AccountRow,
  ModelAliasMap,
  NewAccountRow,
  SupportedModelList,
} from "./schema/accounts"
export { accounts } from "./schema/accounts"
export type { AdminCredentialRow, NewAdminCredentialRow } from "./schema/admin-credentials"
export { adminCredentials } from "./schema/admin-credentials"
export type { AdminSessionRow, NewAdminSessionRow } from "./schema/admin-sessions"
export { adminSessions } from "./schema/admin-sessions"
export type {
  ApiKeyAccountRow,
  ApiKeyPoolRow,
  NewApiKeyAccountRow,
  NewApiKeyPoolRow,
} from "./schema/api-key-scope"
export { apiKeyAccounts, apiKeyPools } from "./schema/api-key-scope"
export type { ApiKeyTombstoneRow } from "./schema/api-key-tombstones"
export { apiKeyTombstones } from "./schema/api-key-tombstones"
export type { ApiKeyRow, NewApiKeyRow } from "./schema/api-keys"
export { apiKeys } from "./schema/api-keys"
export type {
  AuditActorKind,
  AuditDetail,
  AuditEventRow,
  NewAuditEventRow,
} from "./schema/audit-events"
export { AUDIT_ACTOR_KINDS, auditEvents } from "./schema/audit-events"
export type { CostBasis, UsageOutcome } from "./schema/enums"
export {
  accountStatus,
  costBasis,
  keyScope,
  providerId,
  resetSource,
  routingPolicy,
  scheduledTask,
  scheduledTaskOutcome,
  USAGE_OUTCOME_SUCCESS,
  utilizationSource,
} from "./schema/enums"
export * as schema from "./schema/index"
export { type ModelCatalogRow, modelCatalog, type NewModelCatalogRow } from "./schema/model-catalog"
export type { NewOauthStateRow, OauthStateInitiator, OauthStateRow } from "./schema/oauth-states"
export { oauthStates } from "./schema/oauth-states"
export type { PendingClaudeLoginRow } from "./schema/pending-claude-logins"
export type { NewPoolMemberRow, NewPoolRow, PoolMemberRow, PoolRow } from "./schema/pools"
export { poolMembers, pools } from "./schema/pools"
export type { NewPriceOverrideRow, PriceOverrideRow } from "./schema/price-overrides"
export { priceOverrides } from "./schema/price-overrides"
export { type NewQuotaWindowRow, type QuotaWindowRow, quotaWindows } from "./schema/quota-windows"
export type { NewScheduledTaskRunRow, ScheduledTaskRunRow } from "./schema/scheduled-task-runs"
export { scheduledTaskRuns } from "./schema/scheduled-task-runs"
export type {
  NewSessionRow,
  SessionFingerprintSource,
  SessionLineageState,
  SessionRow,
} from "./schema/sessions"
export { sessions } from "./schema/sessions"
export { type NewUsageDailyRow, type UsageDailyRow, usageDaily } from "./schema/usage-daily"
export { type NewUsageRecordRow, type UsageRecordRow, usageRecords } from "./schema/usage-records"
export { type NewUsageReportRow, type UsageReportRow, usageReports } from "./schema/usage-reports"
export type {
  UsageRequestTerminalInsert,
  UsageRequestTerminalRow,
} from "./schema/usage-request-terminals"
