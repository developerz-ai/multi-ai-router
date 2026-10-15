import { desc, eq, sql } from "drizzle-orm"
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
  }
}
