import type { Database } from "../client"
import type { NewUsageRecordRow } from "../schema/usage-records"
import {
  createUsageBatchMutation,
  type UsageBatchInsert,
  type UsageBatchResult,
} from "./usage-batch-mutation"
import { createUsageDetailRetention } from "./usage-history-maintenance"

/**
 * Postgres' bind ceiling. The extended protocol's Bind message counts parameters
 * in an Int16, so no statement may carry more than this — a protocol constant,
 * not a server setting an operator can raise.
 */
export const PG_MAX_BIND_PARAMETERS = 65_535

/**
 * Bind parameters one row of `insertMany` spends: one per column the writer sets.
 * Includes the stable event ID and the final client-facing response status.
 *
 * Stated rather than derived from the table, because "how many columns does the
 * writer set" is not a property the schema knows: a new nullable column costs a
 * parameter only once something fills it in. `test/unit/repositories/usage-batch-limit.test.ts`
 * builds the real statement and fails when this drifts, so the number cannot go
 * stale quietly.
 */
export const USAGE_RECORD_BIND_PARAMETERS_PER_ROW = 28

/**
 * Maximum raw INSERT rows when all 28 writable cells are bound.
 *
 * This bounds configured recorder batches at boot. The repository additionally chunks each
 * table's statements using its conservative schema column count, preserving one transaction
 * for a larger direct-call batch. It may split before this limit when defaults spend no binds.
 */
export const USAGE_RECORD_MAX_BATCH_ROWS = Math.floor(
  PG_MAX_BIND_PARAMETERS / USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
)

/** Explicit IDs make commit-then-acknowledgment-loss retries idempotent. */
export type UsageRecordInsert = NewUsageRecordRow & { readonly id: string }

/**
 * Usage persistence. One row per upstream attempt.
 *
 * Every method here is **off the request path** — the recorder in
 * `apps/api/src/services/usage/` queues records in memory and calls `insertBatch`
 * from a background flush, so a slow database degrades reporting and never
 * touches latency (docs/idea/01-architecture.md, performance budget).
 *
 * `insertBatch` admits attempts, terminal settlements and contribution receipts atomically;
 * `insertMany` delegates attempt-only batches. Immutable event facts are never rewritten:
 * replay checks identity before it can update history. Raw retention is age-bounded and
 * requires matching admitted evidence, rather than deleting unregistered facts by age alone.
 */
export interface UsageRecordRepository {
  /**
   * Persists raw facts, receipts and history in one transaction with bounded statements.
   *
   * An empty batch is a no-op rather than an error: the flush timer fires on a
   * schedule, not on demand, so it routinely has nothing to do.
   *
   * Recorder batches are bounded at {@link USAGE_RECORD_MAX_BATCH_ROWS}; direct larger batches
   * are split within the same transaction, including rollback of earlier chunks on failure.
   */
  insertBatch(input: UsageBatchInsert): Promise<UsageBatchResult>
  insertMany(rows: readonly UsageRecordInsert[]): Promise<number>
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
  deleteRetainedBatch(input: {
    readonly retentionDays: number
    readonly limit: number
  }): Promise<number>
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
}

export function createUsageRecordRepository(db: Database): UsageRecordRepository {
  const insertBatch = createUsageBatchMutation(db)
  return {
    insertBatch,
    insertMany: async (rows) => {
      if (rows.length === 0) return 0
      return (await insertBatch({ attempts: rows, terminals: [] })).insertedAttempts
    },

    ...createUsageDetailRetention(db),
  }
}
