/**
 * `@multi-ai-router/db` — the only module in the system that knows SQL.
 *
 * Public surface, explicitly listed: the schema (tables + enums + row types),
 * the connection factory, the migration runner, and the repositories services
 * call instead of writing queries.
 */

export type { AdvisoryLockRun } from "./advisory-lock"

// --- leader election --------------------------------------------------------
export { advisoryLockKey, advisoryUnlock, tryAdvisoryLock, withAdvisoryLock } from "./advisory-lock"
export type { Database, DatabaseHandle, DatabaseOptions, SqlConnection } from "./client"

// --- connection -------------------------------------------------------------
export { createDatabase } from "./client"
export type { MigrateOptions } from "./migrate"

// --- migrations -------------------------------------------------------------
export { defaultMigrationsFolder, runMigrations } from "./migrate"
export type {
  AccountListFilter,
  AccountRepository,
  CreateAccountInput,
} from "./repositories/account-repository"
// --- repositories -----------------------------------------------------------
export { createAccountRepository } from "./repositories/account-repository"
export type { ApiKeyRepository } from "./repositories/api-key-repository"
export { createApiKeyRepository } from "./repositories/api-key-repository"
export type { AppendAuditEventInput, AuditRepository } from "./repositories/audit-repository"
export { createAuditRepository } from "./repositories/audit-repository"
export type {
  CreateOauthStateInput,
  OauthStateRepository,
} from "./repositories/oauth-state-repository"
export { createOauthStateRepository } from "./repositories/oauth-state-repository"
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
export { createPriceOverrideRepository } from "./repositories/price-override-repository"
export type {
  FinishScheduledTaskInput,
  ScheduledTaskName,
  ScheduledTaskOutcome,
  ScheduledTaskRepository,
} from "./repositories/scheduled-task-repository"
export { createScheduledTaskRepository } from "./repositories/scheduled-task-repository"
export type {
  SessionRepository,
  UpsertSessionInput,
} from "./repositories/session-repository"
export { createSessionRepository } from "./repositories/session-repository"
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
export type {
  UsageDimension,
  UsageGroupRow,
  UsageGroupSeriesPoint,
  UsageLatency,
  UsageReadRepository,
  UsageSeriesPoint,
  UsageTotals,
  UsageWindow,
} from "./repositories/usage-read-repository"
export { createUsageReadRepository } from "./repositories/usage-read-repository"
export type {
  RecentAttemptQuery,
  RecentAttemptRow,
  UsageRecentRepository,
} from "./repositories/usage-recent-repository"
export { createUsageRecentRepository } from "./repositories/usage-recent-repository"
export type { UsageRecordRepository } from "./repositories/usage-repository"
export { createUsageRecordRepository } from "./repositories/usage-repository"
// --- row types --------------------------------------------------------------
export type {
  AccountRow,
  ModelAliasMap,
  NewAccountRow,
  SupportedModelList,
} from "./schema/accounts"

// --- tables -----------------------------------------------------------------
export { accounts } from "./schema/accounts"
export type {
  ApiKeyAccountRow,
  ApiKeyPoolRow,
  NewApiKeyAccountRow,
  NewApiKeyPoolRow,
} from "./schema/api-key-scope"
export { apiKeyAccounts, apiKeyPools } from "./schema/api-key-scope"
export type { ApiKeyRow, NewApiKeyRow } from "./schema/api-keys"
export { apiKeys } from "./schema/api-keys"
export type { AuditDetail, AuditEventRow, NewAuditEventRow } from "./schema/audit-events"
export { auditEvents } from "./schema/audit-events"
export type { CostBasis, UsageOutcome } from "./schema/enums"
// --- enums ------------------------------------------------------------------
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
// The whole schema as one namespace, for `drizzle(sql, { schema })` and for
// query builders that need a table this barrel does not name individually.
export * as schema from "./schema/index"
export type { NewOauthStateRow, OauthStateRow } from "./schema/oauth-states"
export { oauthStates } from "./schema/oauth-states"
export type { NewPoolMemberRow, NewPoolRow, PoolMemberRow, PoolRow } from "./schema/pools"
export { poolMembers, pools } from "./schema/pools"
export type { NewPriceOverrideRow, PriceOverrideRow } from "./schema/price-overrides"
export { priceOverrides } from "./schema/price-overrides"
export type { NewQuotaWindowRow, QuotaWindowRow } from "./schema/quota-windows"
export { quotaWindows } from "./schema/quota-windows"
export type { NewScheduledTaskRunRow, ScheduledTaskRunRow } from "./schema/scheduled-task-runs"
export { scheduledTaskRuns } from "./schema/scheduled-task-runs"
export type {
  NewSessionRow,
  SessionFingerprintSource,
  SessionLineageState,
  SessionRow,
} from "./schema/sessions"
export { sessions } from "./schema/sessions"
export type { NewUsageDailyRow, UsageDailyRow } from "./schema/usage-daily"
export { usageDaily } from "./schema/usage-daily"
export type { NewUsageRecordRow, UsageRecordRow } from "./schema/usage-records"
export { usageRecords } from "./schema/usage-records"
