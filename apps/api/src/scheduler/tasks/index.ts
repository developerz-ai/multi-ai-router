import { worstCaseTickMs } from "../../services/routing/exhausted-retest"
import type { ScheduledTask } from "../types"
import { createAdminSessionPurgeTask } from "./admin-session-purge"
import { createConfigDirReapTask } from "./config-dir-reap"
import { createCooldownRecheckTasks } from "./cooldown-recheck"
import { createCredentialTasks } from "./credential-tasks"
import type { ScheduledTaskDeps } from "./deps"
import { createIdleAccountProbeTask } from "./idle-account-probe"
import { scheduledTaskIntervals } from "./intervals"
import { createJanitorTask } from "./janitor"
import { createModelCatalogRefreshTask } from "./model-catalog-refresh"
import { createOauthPurgeTask } from "./oauth-purge"
import { createPlanQuotaReadTasks } from "./plan-quota-read"
import { createPoolReapTasks } from "./pool-reap"
import { createQuotaFloorTask } from "./quota-floor"
import { createReportTasks } from "./report-tasks"
import { createTranscriptSweepTask } from "./sdk-transcript-sweep"
import { createUsageRollupTask } from "./usage-rollup"

export type { ScheduledTaskDeps } from "./deps"

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

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** Builds every periodic task this process runs, in `scheduled_task` enum order. */
export function createScheduledTasks(deps: ScheduledTaskDeps): readonly ScheduledTask[] {
  const { env } = deps
  const batchSize = env.scheduler.sweepBatchSize
  const intervals = scheduledTaskIntervals(env)

  return [
    createJanitorTask({
      sessions: deps.sessions,
      usageRecords: deps.usageRecords,
      history: deps.history,
      auditEvents: deps.auditEvents,
      taskRuns: deps.scheduledTasks,
      keyTombstones: deps.keyTombstones,
      usageReports: deps.usageReportRows,
      retention: env.retention,
      intervalMs: intervals.janitor_sweep,
      batchSize,
    }),
    createUsageRollupTask({
      history: deps.history,
      batchSize,
      intervalMs: intervals.usage_rollup,
      fullScanEveryMs: env.usageBackfillFullScanHours * HOUR_MS,
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
            // a forgotten account still works"; this one asks "spend a turn so a cold credential is
            // refreshed by a process that lives long enough to persist it" — which is also what
            // lets the turn-free gauge read follow. The second has a concrete effect the first
            // never had.
            warmCredentials: env.claudeSdkCredentialKeepalive,
            ...(deps.credentialCold === undefined ? {} : { cold: deps.credentialCold }),
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
            startupDelayMs: env.schedulerLimits.modelCatalogRefreshStartupDelaySeconds * 1000,
          }),
        ]),
    // Access-token keepalive and the daily login-lifetime warn line — `credential-tasks.ts`.
    ...createCredentialTasks(deps, intervals),
    // The weekly usage report, once per UTC week — `report-tasks.ts`.
    ...createReportTasks(deps, intervals),
    // Same bound as the idle sweep, for the same reason: each item may bill or spawn.
    ...createCooldownRecheckTasks(deps.cooldownRecheck, {
      intervalMs: intervals.cooldown_recheck,
      batchSize: env.scheduler.idleAccountProbeBatchSize,
      exhaustedSchedule: {
        firstMs: env.scheduler.exhaustedRecheckFirstMinutes * 60_000,
        maxMs: env.scheduler.exhaustedRecheckMaxMinutes * 60_000,
        // The ladder stops one worst-case timer-and-two-runs span below `maxMs`, so an early re-test
        // and
        // late successor cannot cross the cap. Derived from the runner's bounds, so it cannot drift.
        tickMs: worstCaseTickMs(
          intervals.cooldown_recheck,
          env.scheduler.jitterFraction,
          env.schedulerLimits.taskMaxRunMinutes * 60_000,
        ),
      },
    }),
    // Free plain GETs, so a batch of their own rather than the billed sweeps' small one.
    ...createPlanQuotaReadTasks(deps.planQuotaRead, {
      windows: deps.accounts,
      intervalMs: intervals.plan_quota_read,
      batchSize: env.scheduler.planQuotaReadBatchSize,
    }),
    ...createPoolReapTasks(deps.poolReap, {
      windowMs: env.retention.emptyPoolDays * DAY_MS,
      intervalMs: intervals.pool_reap,
      batchSize,
    }),
  ]
}

export * from "./exports"
