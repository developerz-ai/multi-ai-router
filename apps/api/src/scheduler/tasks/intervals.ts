import type { ScheduledTaskName } from "@multi-ai-router/db"
import type { ScheduledTaskDeps } from "./index"

const MINUTE_MS = 60_000

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
    credential_keepalive: env.claudeLogin.keepaliveIntervalSeconds * 1_000,
    login_lifetime_watch: env.claudeLogin.watchIntervalMinutes * MINUTE_MS,
    usage_weekly_report: env.scheduler.usageReportIntervalMinutes * MINUTE_MS,
    cooldown_recheck: env.scheduler.cooldownRecheckIntervalMinutes * MINUTE_MS,
    plan_quota_read: env.scheduler.planQuotaReadIntervalMinutes * MINUTE_MS,
  }
}
