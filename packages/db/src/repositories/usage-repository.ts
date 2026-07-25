import type { Database } from "../client"
import { type NewUsageRecordRow, usageRecords } from "../schema/usage-records"
import { deleteOldestBatch } from "./bounded-delete"

/**
 * Usage persistence. One row per upstream attempt.
 *
 * Every method here is **off the request path** — the recorder in
 * `apps/api/src/services/usage/` queues records in memory and calls `insertMany`
 * from a background flush, so a slow database degrades reporting and never
 * touches latency (docs/idea/01-architecture.md, performance budget).
 *
 * `insertMany` is the whole *mutation* surface on purpose: a per-record insert
 * would be one round trip per attempt, which is the thing the batching exists to
 * avoid. Usage rows are never updated — a corrected attempt is a new attempt,
 * and the rollup reads them as an append-only stream. The only other write is
 * the janitor's age-bounded delete, which can name a row by nothing but its age.
 */
export interface UsageRecordRepository {
  /**
   * Persists a batch in one statement. Returns the number of rows written.
   *
   * An empty batch is a no-op rather than an error: the flush timer fires on a
   * schedule, not on demand, so it routinely has nothing to do.
   */
  insertMany(rows: readonly NewUsageRecordRow[]): Promise<number>
  /**
   * Deletes records created before `cutoff` in one bounded batch, oldest first,
   * and returns how many went. Exactly `limit` means there is more to do and the
   * run should report `partial`.
   *
   * This is the write-heaviest table in the schema, so the sweep is bounded
   * rather than a single statement: the batch rides
   * `usage_records_created_at_idx` and holds locks on at most `limit` rows while
   * the recorder keeps writing.
   *
   * Rolled-up history in `usage_daily` outlives these rows by design — a totals
   * report must not shrink because the raw attempts aged out.
   */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
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

    deleteOlderThan: (cutoff, limit) =>
      deleteOldestBatch({
        db,
        table: usageRecords,
        id: usageRecords.id,
        agedBy: usageRecords.createdAt,
        cutoff,
        limit,
      }),
  }
}
