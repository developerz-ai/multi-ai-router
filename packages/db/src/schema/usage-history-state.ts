import { bigint, date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
/** Accounted source revisions serialize maintenance with admission, independently of app clocks. */
export const usageHistoryState = pgTable("usage_history_state", {
  id: text("id").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  retentionBeforeDay: date("retention_before_day", { mode: "string" }),
  /**
   * First fully measured day of the unpriced-attempts measure, seeded by its migration to the day
   * after it runs. Days before it were written without the measure, so reads report them as not
   * measured rather than as zero.
   */
  unpricedSince: date("unpriced_since", { mode: "string" }),
  /**
   * Banked-through watermark (#275): every `usage_records` row at or before `(created_at, id)` of
   * this pair has a non-pending contribution. Written only by `backfill`, and only after a sweep
   * that began with no resume cursor ended short of its limit, so the whole table was provably
   * clean inside that transaction. `coverage` then runs its `pending` check over the rows after
   * the pair only. NULL, either column, means no proof yet: scan everything.
   */
  bankedThroughAt: timestamp("banked_through_at", { withTimezone: true, mode: "date" }),
  bankedThroughId: uuid("banked_through_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
