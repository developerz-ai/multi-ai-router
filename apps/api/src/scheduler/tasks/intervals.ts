import type { ScheduledTaskName } from "@multi-ai-router/db"
import type { ScheduledTaskDeps } from "./deps"

const MINUTE_MS = 60_000

/**
 * Every runtime task's cadence, in milliseconds, keyed by its `scheduled_task` name.
 * `pool_roster_check` is absent because it only exists when a roster is configured: its cadence
 * comes from {@link poolRosterCheckIntervalMs}, which answers `null` when there is nothing to run.
 *
 * Exported because the admin plane's task-health screen has to judge "is this
 * task overdue?" against the schedule *this process is actually running*
 * (docs/idea/08-observability.md#scheduled-task-visibility). Restating the
 * arithmetic there would let the screen call a task healthy on a cadence nobody
 * configured, so both readers take it from here.
 */
export function scheduledTaskIntervals(
  env: ScheduledTaskDeps["env"],
): Readonly<Record<Exclude<ScheduledTaskName, "pool_roster_check">, number>> {
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
    credential_keepalive: env.claudeLogin.keepaliveIntervalSeconds * 1_000,
    login_lifetime_watch: env.claudeLogin.watchIntervalMinutes * MINUTE_MS,
    usage_weekly_report: env.scheduler.usageReportIntervalMinutes * MINUTE_MS,
    cooldown_recheck: env.scheduler.cooldownRecheckIntervalMinutes * MINUTE_MS,
    plan_quota_read: env.scheduler.planQuotaReadIntervalMinutes * MINUTE_MS,
    pool_reap: env.scheduler.poolReapIntervalMinutes * MINUTE_MS,
  }
}

/**
 * `pool_roster_check`'s cadence, or `null` when no roster is configured — the one place the
 * existence of the task is decided, so `index.ts` cannot construct one without a roster to check.
 * Kept out of {@link scheduledTaskIntervals} rather than added to it as optional: widening that
 * record to `Partial` would force every reader of a cadence to handle `undefined` for fifteen
 * tasks that always have one.
 */
export function poolRosterCheckIntervalMs(env: ScheduledTaskDeps["env"]): number | null {
  return env.poolRoster === null ? null : env.poolRosterCheckIntervalMinutes * MINUTE_MS
}
