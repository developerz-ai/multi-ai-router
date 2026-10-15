import { describe, expect, test } from "bun:test"
import type { RetentionConfig } from "../../../src/config/env"
import { createJanitorTask } from "../../../src/scheduler"
import { silentLogger } from "./fixtures"

/**
 * The janitor's weekly-report category. Its cutoff must be the tick's clock minus the window,
 * to the millisecond: with the 14-day floor the target week's row is almost exactly 14 days old
 * just before Monday 00:00 UTC, so a cutoff rounded up to a date would sweep a row the task is
 * about to regenerate (and, after delivery lands, post again). The SQL side of the boundary is
 * pinned against Postgres in `packages/db/test/integration/usage-reports.test.ts`.
 */
const RETENTION: RetentionConfig = {
  sessionsHours: 1,
  usageDays: 1,
  usageDailyDays: 1,
  auditDays: 1,
  taskRunsDays: 1,
  revokedKeysDays: 1,
  oauthStateMinutes: 10,
  orphanConfigDirHours: 1,
  sdkTranscriptHours: 1,
  usageReportsDays: 14,
}

const never = async () => 0

describe("the janitor's weekly report sweep", () => {
  test("sweeps usage_reports at exactly now minus the window, and counts it", async () => {
    const now = new Date("2026-10-18T23:59:59.000Z")
    const cutoffs: Date[] = []
    const task = createJanitorTask({
      sessions: { deleteIdleBefore: never },
      usageRecords: { deleteRetainedBatch: never },
      history: { deleteRetainedHistory: never },
      auditEvents: { deleteOlderThan: never },
      taskRuns: { deleteOlderThan: never },
      keyTombstones: { purgeRevoked: never, deleteOlderThan: never },
      usageReports: {
        deleteOlderThan: async (cutoff: Date) => {
          cutoffs.push(cutoff)
          return cutoffs.length === 1 ? 2 : 0
        },
      },
      retention: RETENTION,
      intervalMs: 60_000,
      batchSize: 5,
    })

    const result = await task.run({
      now,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(cutoffs[0]?.toISOString()).toBe("2026-10-04T23:59:59.000Z")
    expect((result as { counts: Record<string, number> }).counts.usageReports).toBe(2)
    expect(result.itemsProcessed).toBe(2)
  })
})
