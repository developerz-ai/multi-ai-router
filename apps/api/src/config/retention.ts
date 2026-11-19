import type { ParsedEnv } from "./env-schema"
import type { RetentionConfig } from "./env-storage-types"

/**
 * Every retention window, from env (CLAUDE.md non-negotiable 11). The three usage windows arrive
 * already read, because boot validates them against each other before this runs.
 */
export function readRetentionEnv(
  raw: ParsedEnv,
  validated: Pick<RetentionConfig, "usageDays" | "usageDailyDays" | "usageReportsDays">,
): RetentionConfig {
  return {
    sessionsHours: raw.RETENTION_SESSIONS_HOURS ?? 24,
    ...validated,
    auditDays: raw.RETENTION_AUDIT_DAYS ?? 365,
    // A month of run rows: long enough to answer "has this task been failing all week", short
    // enough that six tasks ticking as often as every five minutes stay a table nobody notices.
    taskRunsDays: raw.RETENTION_TASK_RUNS_DAYS ?? 30,
    revokedKeysDays: raw.RETENTION_REVOKED_KEYS_DAYS ?? 30,
    oauthStateMinutes: raw.RETENTION_OAUTH_STATE_MINUTES ?? 10,
    // A day, because the failure it covers is a crash between provisioning a directory and
    // inserting the row that names it, and the operator who notices at all notices the next
    // morning. Shortening it buys a little disk and risks deleting a live login.
    orphanConfigDirHours: raw.RETENTION_ORPHAN_CONFIG_DIR_HOURS ?? 24,
    // The same day the idle-session row gets, so the file and the row that resumes it age out
    // together. Longer keeps warm resumes for conversations that pause overnight; shorter
    // trades disk for a cold replay on the next turn.
    sdkTranscriptHours: raw.RETENTION_SDK_TRANSCRIPT_HOURS ?? 24,
    // A week: long enough that an operator rebuilding a pool's accounts never races it, short
    // enough that a pool nobody refilled stops answering keys with an empty-candidate refusal.
    emptyPoolDays: raw.RETENTION_EMPTY_POOL_DAYS ?? 7,
  }
}
