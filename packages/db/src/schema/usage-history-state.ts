import { bigint, date, pgTable, text, timestamp } from "drizzle-orm/pg-core"
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
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
