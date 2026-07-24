import type { Database } from "../client"
import { type NewUsageRecordRow, usageRecords } from "../schema/usage-records"

/**
 * Usage persistence. One row per upstream attempt.
 *
 * Every method here is **off the request path** — the recorder in
 * `apps/api/src/services/usage/` queues records in memory and calls `insertMany`
 * from a background flush, so a slow database degrades reporting and never
 * touches latency (docs/idea/01-architecture.md, performance budget).
 *
 * `insertMany` is the whole write surface on purpose: a per-record insert would
 * be one round trip per attempt, which is the thing the batching exists to
 * avoid. Usage rows are also never updated — a corrected attempt is a new
 * attempt, and the rollup reads them as an append-only stream.
 */
export interface UsageRecordRepository {
  /**
   * Persists a batch in one statement. Returns the number of rows written.
   *
   * An empty batch is a no-op rather than an error: the flush timer fires on a
   * schedule, not on demand, so it routinely has nothing to do.
   */
  insertMany(rows: readonly NewUsageRecordRow[]): Promise<number>
}

export function createUsageRecordRepository(db: Database): UsageRecordRepository {
  return {
    insertMany: async (rows) => {
      if (rows.length === 0) return 0
      const written = await db
        .insert(usageRecords)
        .values([...rows])
        .returning({ id: usageRecords.id })
      return written.length
    },
  }
}
