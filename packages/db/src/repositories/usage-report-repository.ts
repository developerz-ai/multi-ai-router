import type { UsageReportDeliveryStatus } from "@multi-ai-router/core"
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { type UsageReportRow, usageReports } from "../schema/usage-reports"

/**
 * Stored weekly usage reports (issue #227). Repositories own SQL; this is the only file that knows
 * `usage_reports` is a table.
 *
 * `period_start` is a UTC Monday as `YYYY-MM-DD`; `date` columns are read and written as strings
 * so no timezone can move a week.
 */
export interface NewUsageReport {
  readonly periodStart: string
  readonly periodEnd: string
  readonly generatedAt: Date
  readonly payload: unknown
}

/** A report without its payload: what the list endpoint and the delivery cursor need. */
export type UsageReportSummary = Omit<UsageReportRow, "payload" | "id">

export interface UsageReportRepository {
  /**
   * `INSERT ... ON CONFLICT (period_start) DO NOTHING`. `true` when this call wrote the row,
   * `false` when the week already had one, so two generations that bypass the advisory lock leave
   * one row and exactly one caller learns it was theirs. A new row starts `pending`.
   */
  insertIfAbsent(input: NewUsageReport): Promise<boolean>
  exists(periodStart: string): Promise<boolean>
  findByPeriodStart(periodStart: string): Promise<UsageReportRow | undefined>
  /** Newest week first, without payloads. */
  list(limit: number): Promise<UsageReportSummary[]>
  /**
   * Deletes one bounded batch of reports whose `period_start` instant is strictly before
   * `cutoff`, oldest first. The comparison is on the instant (midnight UTC of the week's Monday
   * against the cutoff timestamp), never a cutoff rounded to a date: the retention floor is 14
   * days, so just before Monday 00:00 UTC the target week's row is almost exactly that old and a
   * rounded-up cutoff would sweep a row the task is about to regenerate. Rounding down would be
   * safe but inexact, so it is not done either.
   */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
  /**
   * Claim one delivery attempt (issue #229), before any request goes out:
   * `UPDATE ... SET delivery_attempts = delivery_attempts + 1 WHERE period_start = $1 AND
   * delivery_status = $read AND delivery_attempts = $read RETURNING delivery_attempts`.
   *
   * An optimistic version check on `(status, attempts)`, not a lease: two concurrent deliverers
   * that read the same row produce exactly one claim (and so exactly one webhook request); the
   * loser gets `undefined` and must make no request. Returns the claimed attempts value, which
   * every outcome write below is conditioned on — a stale writer's outcome is a no-op, so the
   * last claim wins and nobody clobbers a newer attempt's result.
   */
  claimForDelivery(
    periodStart: string,
    readStatus: UsageReportDeliveryStatus,
    readAttempts: number,
  ): Promise<number | undefined>
  /**
   * `sent` + `delivered_at` + a cleared `last_error`, only where `delivery_attempts` still equals
   * the claimed value. `true` when this call wrote the transition.
   */
  markDelivered(periodStart: string, claimedAttempts: number, deliveredAt: Date): Promise<boolean>
  /**
   * The give-up transition: `failed` + redacted `last_error`, only from `pending` and only for
   * the claimed attempts. The exactly-once capture of a period's failure ties to `true` here —
   * two deliverers racing to give up produce one transition and one capture.
   */
  markPendingFailed(
    periodStart: string,
    claimedAttempts: number,
    lastError: string,
  ): Promise<boolean>
  /**
   * A re-send's outcome write: `failed` + redacted `last_error` whatever the prior status was
   * (a failed re-send of a `sent` week marks it `failed`), still conditional on the claimed
   * attempts.
   */
  markFailed(periodStart: string, claimedAttempts: number, lastError: string): Promise<boolean>
  /**
   * `not_configured` without touching attempts (no request was made, so none is counted).
   * `pendingOnly` is the task's variant — an older `sent`/`failed` row is never rewritten; the
   * re-send's variant writes whatever the prior status was. `true` only on an actual transition.
   */
  recordNotConfigured(periodStart: string, pendingOnly: boolean): Promise<boolean>
  /** The newest `delivered_at` across all weeks — what Settings shows; `null` if never sent. */
  lastDeliveredAt(): Promise<Date | null>
}

/** Every column but the id and the payload, which the list endpoint does not carry. */
const summaryColumns = {
  periodStart: usageReports.periodStart,
  periodEnd: usageReports.periodEnd,
  generatedAt: usageReports.generatedAt,
  deliveryStatus: usageReports.deliveryStatus,
  deliveryAttempts: usageReports.deliveryAttempts,
  deliveredAt: usageReports.deliveredAt,
  lastError: usageReports.lastError,
}

export function createUsageReportRepository(db: DatabaseExecutor): UsageReportRepository {
  return {
    insertIfAbsent: async (input) => {
      const written = await db
        .insert(usageReports)
        .values({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          generatedAt: input.generatedAt,
          payload: input.payload,
        })
        .onConflictDoNothing({ target: usageReports.periodStart })
        .returning({ id: usageReports.id })
      return written.length > 0
    },

    exists: async (periodStart) => {
      const rows = await db
        .select({ id: usageReports.id })
        .from(usageReports)
        .where(eq(usageReports.periodStart, periodStart))
        .limit(1)
      return rows.length > 0
    },

    findByPeriodStart: async (periodStart) => {
      const [row] = await db
        .select()
        .from(usageReports)
        .where(eq(usageReports.periodStart, periodStart))
        .limit(1)
      return row
    },

    list: async (limit) => {
      return db
        .select(summaryColumns)
        .from(usageReports)
        .orderBy(desc(usageReports.periodStart))
        .limit(limit)
    },

    deleteOlderThan: async (cutoff, limit) => {
      const deleted = await db.execute(sql`
        delete from ${usageReports}
        where ${usageReports.id} in (
          select ${usageReports.id} from ${usageReports}
          where (${usageReports.periodStart}::timestamp at time zone 'UTC') < ${cutoff.toISOString()}::timestamptz
          order by ${usageReports.periodStart} asc
          limit ${limit}
        )
        returning ${usageReports.id}`)
      return [...deleted].length
    },

    claimForDelivery: async (periodStart, readStatus, readAttempts) => {
      const claimed = await db
        .update(usageReports)
        .set({ deliveryAttempts: sql`${usageReports.deliveryAttempts} + 1` })
        .where(
          and(
            eq(usageReports.periodStart, periodStart),
            eq(usageReports.deliveryStatus, readStatus),
            eq(usageReports.deliveryAttempts, readAttempts),
          ),
        )
        .returning({ deliveryAttempts: usageReports.deliveryAttempts })
      return claimed[0]?.deliveryAttempts
    },

    markDelivered: async (periodStart, claimedAttempts, deliveredAt) => {
      const written = await db
        .update(usageReports)
        .set({ deliveryStatus: "sent", deliveredAt, lastError: null })
        .where(
          and(
            eq(usageReports.periodStart, periodStart),
            eq(usageReports.deliveryAttempts, claimedAttempts),
          ),
        )
        .returning({ id: usageReports.id })
      return written.length > 0
    },

    markPendingFailed: async (periodStart, claimedAttempts, lastError) => {
      const written = await db
        .update(usageReports)
        .set({ deliveryStatus: "failed", lastError })
        .where(
          and(
            eq(usageReports.periodStart, periodStart),
            eq(usageReports.deliveryStatus, "pending"),
            eq(usageReports.deliveryAttempts, claimedAttempts),
          ),
        )
        .returning({ id: usageReports.id })
      return written.length > 0
    },

    markFailed: async (periodStart, claimedAttempts, lastError) => {
      const written = await db
        .update(usageReports)
        .set({ deliveryStatus: "failed", lastError })
        .where(
          and(
            eq(usageReports.periodStart, periodStart),
            eq(usageReports.deliveryAttempts, claimedAttempts),
          ),
        )
        .returning({ id: usageReports.id })
      return written.length > 0
    },

    recordNotConfigured: async (periodStart, pendingOnly) => {
      const written = await db
        .update(usageReports)
        .set({ deliveryStatus: "not_configured" })
        .where(
          and(
            eq(usageReports.periodStart, periodStart),
            pendingOnly
              ? eq(usageReports.deliveryStatus, "pending")
              : ne(usageReports.deliveryStatus, "not_configured"),
          ),
        )
        .returning({ id: usageReports.id })
      return written.length > 0
    },

    lastDeliveredAt: async () => {
      const [row] = await db
        .select({ deliveredAt: usageReports.deliveredAt })
        .from(usageReports)
        .where(isNotNull(usageReports.deliveredAt))
        .orderBy(desc(usageReports.deliveredAt))
        .limit(1)
      return row?.deliveredAt ?? null
    },
  }
}
