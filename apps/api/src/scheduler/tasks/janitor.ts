import type {
  ApiKeyTombstoneRepository,
  AuditRepository,
  ScheduledTaskRepository,
  SessionRepository,
  UsageHistoryRepository,
  UsageRecordRepository,
} from "@multi-ai-router/db"
import type { RetentionConfig } from "../../config/env"
import type { ScheduledTask } from "../types"
import { runSweeps } from "./sweep"

/**
 * The janitor: the retention sweep for the seven tables that grow without bound.
 *
 * One task rather than seven, because they share a schedule and an operator reads
 * them as one answer — "the janitor ran 4 min ago and deleted 812 rows"
 * (docs/idea/09-deployment.md, "Cleanups & retention"). The per-category counts
 * are in the summary line, so "deleted 812 rows" can still be broken down.
 *
 * **Every window is `env.retention`, never a number in this file** (CLAUDE.md
 * non-negotiable 11). What is decided here is only the *order*, and it is
 * deliberate: revoked keys go after the rest, because deleting one cascades to its
 * sessions and scope rows (its usage rows keep the id, and a tombstone written in the same
 * statement keeps the name), and doing that first would make the sweeps in front of it race their
 * own cascade for no reason. The key-tombstone sweep goes last: it touches only its own table, and
 * a tombstone written by this very tick's purge is far too young to be swept.
 *
 * Two of the seven grow slowly enough to have been overlooked rather than
 * excluded, and both are here for the same reason the other five are: `usage_daily`
 * banks one row per distinct `(day, key, account, pool, model)` and outlives the
 * raw rows by design, which is not the same as outliving them forever; and
 * `scheduled_task_runs` takes a row per task per tick, about a thousand a day,
 * for as long as the process runs.
 *
 * Idempotency comes free from the shape of the work: the cutoff is computed from
 * the tick's clock and the predicate is an age, so a sweep that runs twice finds
 * nothing the second time and a sweep killed halfway leaves a smaller backlog,
 * never an inconsistent one.
 *
 * The OAuth `state` purge is deliberately *not* here: it is its own
 * `scheduled_task` enum value on its own much shorter cadence (minutes, not
 * hours), because a one-shot PKCE verifier that outlives its TTL by an hour is a
 * secret kept for no reason.
 */

export interface JanitorDeps {
  readonly sessions: Pick<SessionRepository, "deleteIdleBefore">
  readonly usageRecords: Pick<UsageRecordRepository, "deleteRetainedBatch">
  readonly history: Pick<UsageHistoryRepository, "deleteRetainedHistory">
  readonly auditEvents: Pick<AuditRepository, "deleteOlderThan">
  readonly taskRuns: Pick<ScheduledTaskRepository, "deleteOlderThan">
  readonly keyTombstones: Pick<ApiKeyTombstoneRepository, "purgeRevoked" | "deleteOlderThan">
  /** Every retention window, straight from `env.retention`. */
  readonly retention: RetentionConfig
  /** `JANITOR_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `SWEEP_BATCH_SIZE`. */
  readonly batchSize: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function createJanitorTask(deps: JanitorDeps): ScheduledTask {
  const { retention } = deps

  return {
    name: "janitor_sweep",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      // Read once, off the tick's clock, so every category is measured against
      // the same instant however long the sweep runs.
      const idleSessions = before(now, retention.sessionsHours * HOUR_MS)
      const staleAudit = before(now, retention.auditDays * DAY_MS)
      const staleTaskRuns = before(now, retention.taskRunsDays * DAY_MS)
      const purgeableKeys = before(now, retention.revokedKeysDays * DAY_MS)
      // A tombstone labels rollups, so it lives as long as they do — plus one day, because rollups
      // age by whole UTC day: the purge day's own rollup is still inside the window for up to a day
      // after `purged_at + usageDailyDays`.
      const staleTombstones = before(now, (retention.usageDailyDays + 1) * DAY_MS)

      const report = await runSweeps(
        [
          {
            category: "sessions",
            deleteBatch: (limit) => deps.sessions.deleteIdleBefore(idleSessions, limit),
          },
          {
            category: "usageRecords",
            deleteBatch: (limit) =>
              deps.usageRecords.deleteRetainedBatch({ retentionDays: retention.usageDays, limit }),
          },
          // Raw retention removes only rows with admitted contribution receipts. History retention
          // separately advances the durable horizon and removes the older analytical facts.
          {
            category: "usageDaily",
            deleteBatch: (limit) =>
              deps.history.deleteRetainedHistory({
                retentionDays: retention.usageDailyDays,
                limit,
              }),
          },
          {
            category: "auditEvents",
            deleteBatch: (limit) => deps.auditEvents.deleteOlderThan(staleAudit, limit),
          },
          // Including this task's own row, in principle — except that it is hours old at most and
          // has no `finishedAt` yet, and the sweep takes neither.
          {
            category: "taskRuns",
            deleteBatch: (limit) => deps.taskRuns.deleteOlderThan(staleTaskRuns, limit),
          },
          {
            category: "revokedKeys",
            // Delete and tombstone are one statement; `purged_at` is this tick's clock.
            deleteBatch: (limit) => deps.keyTombstones.purgeRevoked(purgeableKeys, now, limit),
          },
          {
            category: "keyTombstones",
            deleteBatch: (limit) => deps.keyTombstones.deleteOlderThan(staleTombstones, limit),
          },
        ],
        { batchSize: deps.batchSize, signal },
      )

      // The spec's one-line summary per sweep: what went, per category. The
      // runner's own line carries the duration and the total.
      logger.info("janitor sweep", {
        outcome: report.outcome,
        deleted: report.itemsProcessed,
        counts: report.counts,
      })
      return report
    },
  }
}

function before(now: Date, ageMs: number): Date {
  return new Date(now.getTime() - ageMs)
}
