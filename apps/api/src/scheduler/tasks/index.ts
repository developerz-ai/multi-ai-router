import type {
  AccountRepository,
  ApiKeyRepository,
  AuditRepository,
  OauthStateRepository,
  ScheduledTaskName,
  ScheduledTaskRepository,
  SessionRepository,
  UsageDailyRepository,
  UsageRecordRepository,
} from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import type { HealthStore } from "../../services/dataplane"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"
import type { ScheduledTask } from "../types"
import { type AdminSessionStoreForPurge, createAdminSessionPurgeTask } from "./admin-session-purge"
import { createConfigDirReapTask } from "./config-dir-reap"
import { createIdleAccountProbeTask, type IdleAccountProbeDeps } from "./idle-account-probe"
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
  readonly usageDaily: Pick<UsageDailyRepository, "rollupDay" | "deleteOlderThan">
  /**
   * The admin console's in-memory session store. Not a repository: it lives in this process's
   * heap, so this task never needs the advisory lock's "exactly one replica" guarantee — see the
   * task's own module comment.
   */
  readonly adminSessions: AdminSessionStoreForPurge
  readonly accounts: Pick<
    AccountRepository,
    "list" | "listIds" | "listQuotaWindows" | "upsertQuotaWindow" | "findIdle" | "updateStatusWhen"
  >
  /**
   * The rollup's catch-up cursor, and the janitor's sweep of the run log itself. The runner uses
   * this repository too, for writing those rows in the first place.
   */
  readonly scheduledTasks: Pick<ScheduledTaskRepository, "lastSuccess" | "deleteOlderThan">
  /** The quota floor's freshness read. It never writes health — see that task's note. */
  readonly health: Pick<HealthStore, "stateOf">
  /**
   * The subscription config-directory volume, for the reaper. Built in the composition root rather
   * than here because the admin plane provisions and removes through the same instance.
   */
  readonly configDirs: Pick<AccountConfigDirs, "root" | "list" | "remove">
  /**
   * The keepalive sweep's billed half — the admin plane's own "Test now", handed in rather than
   * rebuilt, so a scheduled probe and an operator's button press share one cooldown, one
   * subprocess gate, and one audit kind. Absent means the sweep has nothing to spend and probes
   * nothing.
   */
  readonly testAccount?: IdleAccountProbeDeps["test"]
  /**
   * The free half: "is this Claude subscription still logged in", asked of the CLI. Absent where
   * no CLI is available, in which case a dead credential is discovered by the paid test instead.
   */
  readonly authProbe?: AccountAuthProbe
  /**
   * Which model each provider is probed with. Empty means nothing is probed — the sweep never
   * invents a model name, because the client picks the model and this is the one place the router
   * would otherwise have to choose one (non-negotiable 4 in spirit).
   */
  readonly probeModels?: Readonly<Record<string, string>>
  /** A full `Env` satisfies this, so the composition root passes `env` straight through. */
  readonly env: Pick<Env, "retention" | "janitorIntervalMinutes" | "scheduler">
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Every task's cadence, in milliseconds, keyed by its `scheduled_task` name.
 *
 * Exported because the admin plane's task-health screen has to judge "is this
 * task overdue?" against the schedule *this process is actually running*
 * (docs/idea/08-observability.md#scheduled-task-visibility). Restating the
 * arithmetic there would let the screen call a task healthy on a cadence nobody
 * configured, so both readers take it from here.
 */
export function scheduledTaskIntervals(
  env: ScheduledTaskDeps["env"],
): Readonly<Record<ScheduledTaskName, number>> {
  return {
    janitor_sweep: env.janitorIntervalMinutes * MINUTE_MS,
    usage_rollup: env.scheduler.usageRollupIntervalMinutes * MINUTE_MS,
    oauth_state_purge: env.scheduler.oauthStatePurgeIntervalMinutes * MINUTE_MS,
    quota_floor_refresh: env.scheduler.quotaFloorIntervalMinutes * MINUTE_MS,
    config_dir_reap: env.scheduler.configDirReapIntervalMinutes * MINUTE_MS,
    admin_session_purge: env.scheduler.adminSessionPurgeIntervalMinutes * MINUTE_MS,
    idle_account_probe: env.scheduler.idleAccountProbeIntervalMinutes * MINUTE_MS,
  }
}

/** Builds every periodic task this process runs, in `scheduled_task` enum order. */
export function createScheduledTasks(deps: ScheduledTaskDeps): readonly ScheduledTask[] {
  const { env } = deps
  const batchSize = env.scheduler.sweepBatchSize
  const intervals = scheduledTaskIntervals(env)

  return [
    createJanitorTask({
      sessions: deps.sessions,
      usageRecords: deps.usageRecords,
      usageDaily: deps.usageDaily,
      auditEvents: deps.auditEvents,
      taskRuns: deps.scheduledTasks,
      apiKeys: deps.apiKeys,
      retention: env.retention,
      intervalMs: intervals.janitor_sweep,
      batchSize,
    }),
    createUsageRollupTask({
      usageDaily: deps.usageDaily,
      scheduledTasks: deps.scheduledTasks,
      retention: env.retention,
      intervalMs: intervals.usage_rollup,
    }),
    createOauthPurgeTask({
      oauthStates: deps.oauthStates,
      intervalMs: intervals.oauth_state_purge,
      batchSize,
    }),
    createQuotaFloorTask({
      accounts: deps.accounts,
      health: deps.health,
      intervalMs: intervals.quota_floor_refresh,
      // The interval *is* the idleness threshold: the floor's job is to cover
      // exactly the accounts traffic did not refresh since it last looked.
      // Deriving it here keeps the two from ever drifting apart, and keeps a
      // knob out of `.env` that nobody could tune meaningfully.
      idleAfterMs: intervals.quota_floor_refresh,
    }),
    createConfigDirReapTask({
      configDirs: deps.configDirs,
      accounts: deps.accounts,
      graceMs: env.retention.orphanConfigDirHours * HOUR_MS,
      intervalMs: intervals.config_dir_reap,
      batchSize,
    }),
    createAdminSessionPurgeTask({
      sessions: deps.adminSessions,
      intervalMs: intervals.admin_session_purge,
    }),
    // Last, and the only task here that spends money. It exists because a Claude subscription's
    // tokens are refreshed by the SDK *when it runs*, so an account traffic forgets expires on its
    // own — see the module header for why the free auth check comes first.
    //
    // Built only when there is something to spend: a deployment with no test service wired gets no
    // task at all rather than one that ticks and does nothing.
    ...(deps.testAccount === undefined
      ? []
      : [
          createIdleAccountProbeTask({
            accounts: deps.accounts,
            test: deps.testAccount,
            ...(deps.authProbe === undefined ? {} : { auth: deps.authProbe }),
            models: deps.probeModels ?? {},
            intervalMs: intervals.idle_account_probe,
            idleAfterMs: env.scheduler.idleAccountAfterDays * DAY_MS,
            // Deliberately not `sweepBatchSize`: every item here may spawn a ~245 MB subprocess
            // and bill a turn, which is nothing like deleting a row, so it gets a much smaller
            // bound of its own.
            batchSize: env.scheduler.idleAccountProbeBatchSize,
          }),
        ]),
  ]
}

export type { AdminSessionPurgeDeps, AdminSessionStoreForPurge } from "./admin-session-purge"
export { createAdminSessionPurgeTask } from "./admin-session-purge"
export type { ConfigDirReapDeps, OrphanConfigDir, ReapPlan, ReapPlanInput } from "./config-dir-reap"
export { createConfigDirReapTask, planConfigDirReap } from "./config-dir-reap"
export type { IdleAccountProbeDeps } from "./idle-account-probe"
export { createIdleAccountProbeTask, IDLE_PROBE_MODELS } from "./idle-account-probe"
export type { JanitorDeps } from "./janitor"
export { createJanitorTask } from "./janitor"
export type { OauthPurgeDeps } from "./oauth-purge"
export { createOauthPurgeTask } from "./oauth-purge"
export type { QuotaFloorDeps } from "./quota-floor"
export { createQuotaFloorTask } from "./quota-floor"
export type { Sweep, SweepOptions, SweepReport } from "./sweep"
export { runSweeps } from "./sweep"
export type { UsageRollupDeps } from "./usage-rollup"
export { createUsageRollupTask, rollupDays, rollupFrom } from "./usage-rollup"
