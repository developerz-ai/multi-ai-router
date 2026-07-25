import type {
  AccountRepository,
  ApiKeyRepository,
  AuditRepository,
  OauthStateRepository,
  ScheduledTaskRepository,
  SessionRepository,
  UsageDailyRepository,
  UsageRecordRepository,
} from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { HealthStore } from "../../services/dataplane"
import type { ScheduledTask } from "../types"
import { createJanitorTask } from "./janitor"
import { createOauthPurgeTask } from "./oauth-purge"
import { createQuotaFloorTask } from "./quota-floor"
import { createUsageRollupTask } from "./usage-rollup"

/**
 * The task registry — the list `createScheduler` is handed, and the one place
 * that turns configuration into intervals.
 *
 * Every task's `name` is a `scheduled_task` enum value, so the database schema
 * is what fixes the vocabulary: a task cannot exist under a name the enum has
 * never heard of, and the runner rejects two tasks sharing one name because they
 * would share an advisory lock key and silently serialize.
 *
 * Minutes become milliseconds here and nowhere else. A task takes `intervalMs`
 * already converted so that its file contains no unit arithmetic and no reading
 * of `Env` — which is what keeps it a pure function of its dependencies and
 * testable without an environment.
 */

export interface ScheduledTaskDeps {
  readonly sessions: Pick<SessionRepository, "deleteIdleBefore">
  readonly usageRecords: Pick<UsageRecordRepository, "deleteOlderThan">
  readonly auditEvents: Pick<AuditRepository, "deleteOlderThan">
  readonly apiKeys: Pick<ApiKeyRepository, "deleteRevokedOlderThan">
  readonly oauthStates: Pick<OauthStateRepository, "deleteExpiredBefore">
  readonly usageDaily: Pick<UsageDailyRepository, "rollup">
  readonly accounts: Pick<AccountRepository, "list" | "listQuotaWindows" | "upsertQuotaWindow">
  /** The rollup's catch-up cursor. The runner uses this repository too, for its own run rows. */
  readonly scheduledTasks: Pick<ScheduledTaskRepository, "lastSuccess">
  /** The quota floor's freshness read. It never writes health — see that task's note. */
  readonly health: Pick<HealthStore, "stateOf">
  /** A full `Env` satisfies this, so the composition root passes `env` straight through. */
  readonly env: Pick<Env, "retention" | "janitorIntervalMinutes" | "scheduler">
}

const MINUTE_MS = 60_000

/** Builds every periodic task this process runs, in `scheduled_task` enum order. */
export function createScheduledTasks(deps: ScheduledTaskDeps): readonly ScheduledTask[] {
  const { env } = deps
  const batchSize = env.scheduler.sweepBatchSize
  const quotaFloorMs = env.scheduler.quotaFloorIntervalMinutes * MINUTE_MS

  return [
    createJanitorTask({
      sessions: deps.sessions,
      usageRecords: deps.usageRecords,
      auditEvents: deps.auditEvents,
      apiKeys: deps.apiKeys,
      retention: env.retention,
      intervalMs: env.janitorIntervalMinutes * MINUTE_MS,
      batchSize,
    }),
    createUsageRollupTask({
      usageDaily: deps.usageDaily,
      scheduledTasks: deps.scheduledTasks,
      retention: env.retention,
      intervalMs: env.scheduler.usageRollupIntervalMinutes * MINUTE_MS,
    }),
    createOauthPurgeTask({
      oauthStates: deps.oauthStates,
      intervalMs: env.scheduler.oauthStatePurgeIntervalMinutes * MINUTE_MS,
      batchSize,
    }),
    createQuotaFloorTask({
      accounts: deps.accounts,
      health: deps.health,
      intervalMs: quotaFloorMs,
      // The interval *is* the idleness threshold: the floor's job is to cover
      // exactly the accounts traffic did not refresh since it last looked.
      // Deriving it here keeps the two from ever drifting apart, and keeps a
      // knob out of `.env` that nobody could tune meaningfully.
      idleAfterMs: quotaFloorMs,
    }),
  ]
}

export type { JanitorDeps } from "./janitor"
export { createJanitorTask } from "./janitor"
export type { OauthPurgeDeps } from "./oauth-purge"
export { createOauthPurgeTask } from "./oauth-purge"
export type { QuotaFloorDeps } from "./quota-floor"
export { createQuotaFloorTask } from "./quota-floor"
export type { Sweep, SweepOptions, SweepReport } from "./sweep"
export { runSweeps } from "./sweep"
export type { UsageRollupDeps } from "./usage-rollup"
export { createUsageRollupTask, rollupFrom } from "./usage-rollup"
