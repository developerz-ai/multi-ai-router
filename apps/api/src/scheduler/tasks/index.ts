import type {
  AccountRepository,
  AccountRow,
  ApiKeyRepository,
  AuditRepository,
  ModelCatalogRepository,
  OauthStateRepository,
  ScheduledTaskName,
  ScheduledTaskRepository,
  SessionRepository,
  UsageDailyRepository,
  UsageRecordRepository,
} from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import type { SdkTranscripts } from "../../providers/claude-sdk/transcripts"
import type { HealthStore } from "../../services/dataplane"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"
import type { ScheduledTask } from "../types"
import { type AdminSessionStoreForPurge, createAdminSessionPurgeTask } from "./admin-session-purge"
import { createConfigDirReapTask } from "./config-dir-reap"
import { createIdleAccountProbeTask, type IdleAccountProbeDeps } from "./idle-account-probe"
import { createJanitorTask } from "./janitor"
import {
  createModelCatalogRefreshTask,
  type ModelCatalogRefreshDeps,
} from "./model-catalog-refresh"
import { createOauthPurgeTask } from "./oauth-purge"
import { createQuotaFloorTask } from "./quota-floor"
import { createTranscriptSweepTask } from "./sdk-transcript-sweep"
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
   * The admin console's session store, over the shared `admin_sessions` table. Handed in as the
   * store rather than its repository because the store also evicts what the sweep deletes from
   * its per-replica read cache — see the task's own module comment.
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
   * The session transcripts the `claude` CLI leaves under those same directories, for the
   * transcript sweep. Built beside `configDirs` over the same root.
   */
  readonly transcripts: Pick<SdkTranscripts, "root" | "survey" | "remove">
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
   * The turn-free usage read for one subscription account, for the free half of the sweep. Absent
   * where no CLI is available — the request path's gauge still covers accounts that serve traffic.
   */
  readonly usageProbe?: IdleAccountProbeDeps["usage"]
  /**
   * Which model each provider is probed with. Empty means nothing is probed — the sweep never
   * invents a model name, because the client picks the model and this is the one place the router
   * would otherwise have to choose one (non-negotiable 4 in spirit).
   */
  readonly probeModels?: Readonly<Record<string, string>>
  /**
   * When a subscription account's access token expires — metadata, never a token. Absent disables
   * the credential keepalive, which is what a deployment with no config directories wants.
   */
  readonly accessTokenExpiry?: (account: AccountRow) => Promise<Date | null>
  /**
   * The model catalog's staleness ordering. Read-only here — the writes go through
   * {@link ScheduledTaskDeps.refreshCatalog}, which owns the transaction per account.
   */
  readonly modelCatalog?: Pick<ModelCatalogRepository, "lastRefreshedAt">
  /**
   * One account's catalog refresh, handed in rather than rebuilt, so the hourly sweep and the admin
   * plane's discover button ask an upstream through exactly one parser. Absent means no sweep is
   * built at all — a deployment with nothing wired gets no task rather than one that ticks and
   * does nothing.
   */
  readonly refreshCatalog?: ModelCatalogRefreshDeps["refresh"]
  /** A full `Env` satisfies this, so the composition root passes `env` straight through. */
  readonly env: Pick<
    Env,
    | "retention"
    | "janitorIntervalMinutes"
    | "scheduler"
    | "claudeSdkCredentialKeepalive"
    | "claudeSdkCredentialKeepaliveBeforeMinutes"
  >
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
    sdk_transcript_sweep: env.scheduler.sdkTranscriptSweepIntervalMinutes * MINUTE_MS,
    admin_session_purge: env.scheduler.adminSessionPurgeIntervalMinutes * MINUTE_MS,
    idle_account_probe: env.scheduler.idleAccountProbeIntervalMinutes * MINUTE_MS,
    model_catalog_refresh: env.scheduler.modelCatalogRefreshIntervalMinutes * MINUTE_MS,
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
    createTranscriptSweepTask({
      transcripts: deps.transcripts,
      retentionMs: env.retention.sdkTranscriptHours * HOUR_MS,
      intervalMs: intervals.sdk_transcript_sweep,
      batchSize,
    }),
    createAdminSessionPurgeTask({
      sessions: deps.adminSessions,
      intervalMs: intervals.admin_session_purge,
      batchSize,
    }),
    // The only task here that spends money, and the one that asks every subscription whether
    // it is still logged in: the free `claude auth status` check runs over every CLI-managed
    // account each tick, the billed keepalive only over the idle ones — see the module header,
    // including what a keepalive cannot do about a refresh token's 30-day expiry.
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
            ...(deps.usageProbe === undefined ? {} : { usage: deps.usageProbe }),
            models: deps.probeModels ?? {},
            intervalMs: intervals.idle_account_probe,
            idleAfterMs: env.scheduler.idleAccountAfterDays * DAY_MS,
            // Deliberately not `sweepBatchSize`: every item here may spawn a ~245 MB subprocess
            // and bill a turn, which is nothing like deleting a row, so it gets a much smaller
            // bound of its own.
            batchSize: env.scheduler.idleAccountProbeBatchSize,
            // Off by default: a billed keepalive cannot move a subscription's refresh-token cliff,
            // and checking on a subscription must never spend usage.
            paidTurn: env.scheduler.idleAccountProbePaidTurn,
            // Separate from `paidTurn` on purpose. That flag asks "spend a turn to find out whether
            // a forgotten account still works"; this one asks "spend a turn so a working account
            // does not go cold". The second has a concrete effect the first never had.
            warmCredentials: env.claudeSdkCredentialKeepalive,
            warmBeforeMs: env.claudeSdkCredentialKeepaliveBeforeMinutes * MINUTE_MS,
            ...(deps.accessTokenExpiry === undefined
              ? {}
              : { accessTokenExpiry: deps.accessTokenExpiry }),
          }),
        ]),
    // Hourly, and free: a model listing costs no tokens and spends no quota window. It writes only
    // `model_catalog`, which nothing in routing reads — see that task's header for why that is not
    // in tension with `supported_models` being deliberately timer-free.
    ...(deps.refreshCatalog === undefined || deps.modelCatalog === undefined
      ? []
      : [
          createModelCatalogRefreshTask({
            accounts: deps.accounts,
            catalog: deps.modelCatalog,
            refresh: deps.refreshCatalog,
            intervalMs: intervals.model_catalog_refresh,
            batchSize: env.scheduler.modelCatalogRefreshBatchSize,
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
export type { ModelCatalogRefreshDeps } from "./model-catalog-refresh"
export { createModelCatalogRefreshTask } from "./model-catalog-refresh"
export type { OauthPurgeDeps } from "./oauth-purge"
export { createOauthPurgeTask } from "./oauth-purge"
export type { QuotaFloorDeps } from "./quota-floor"
export { createQuotaFloorTask } from "./quota-floor"
export type {
  TranscriptSweepDeps,
  TranscriptSweepPlan,
  TranscriptSweepPlanInput,
} from "./sdk-transcript-sweep"
export { createTranscriptSweepTask, planTranscriptSweep } from "./sdk-transcript-sweep"
export type { Sweep, SweepOptions, SweepReport } from "./sweep"
export { runSweeps } from "./sweep"
export type { UsageRollupDeps } from "./usage-rollup"
export { createUsageRollupTask, rollupDays, rollupFrom } from "./usage-rollup"
