import type {
  ApiKeyRepository,
  AuditRepository,
  SessionRepository,
  UsageRecordRepository,
} from "@multi-ai-router/db"
import type { RetentionConfig } from "../../config/env"
import type { ScheduledTask } from "../types"
import { runSweeps } from "./sweep"

/**
 * The janitor: the retention sweep for the four tables that grow without bound.
 *
 * One task rather than four, because they share a schedule and an operator reads
 * them as one answer — "the janitor ran 4 min ago and deleted 812 rows"
 * (docs/idea/09-deployment.md, "Cleanups & retention"). The per-category counts
 * are in the summary line, so "deleted 812 rows" can still be broken down.
 *
 * **Every window is `env.retention`, never a number in this file** (CLAUDE.md
 * non-negotiable 11). What is decided here is only the *order*, and it is
 * deliberate: revoked keys go last, because deleting one cascades to its
 * sessions and nulls the key on its usage rows, and doing that first would make
 * the two sweeps in front of it race their own cascade for no reason.
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
  readonly usageRecords: Pick<UsageRecordRepository, "deleteOlderThan">
  readonly auditEvents: Pick<AuditRepository, "deleteOlderThan">
  readonly apiKeys: Pick<ApiKeyRepository, "deleteRevokedOlderThan">
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
      const staleUsage = before(now, retention.usageDays * DAY_MS)
      const staleAudit = before(now, retention.auditDays * DAY_MS)
      const purgeableKeys = before(now, retention.revokedKeysDays * DAY_MS)

      const report = await runSweeps(
        [
          {
            category: "sessions",
            deleteBatch: (limit) => deps.sessions.deleteIdleBefore(idleSessions, limit),
          },
          {
            category: "usageRecords",
            deleteBatch: (limit) => deps.usageRecords.deleteOlderThan(staleUsage, limit),
          },
          {
            category: "auditEvents",
            deleteBatch: (limit) => deps.auditEvents.deleteOlderThan(staleAudit, limit),
          },
          {
            category: "revokedKeys",
            deleteBatch: (limit) => deps.apiKeys.deleteRevokedOlderThan(purgeableKeys, limit),
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
