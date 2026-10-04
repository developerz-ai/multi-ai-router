import { bigint, date, pgTable, text, timestamp } from "drizzle-orm/pg-core"
/** Accounted source revisions serialize maintenance with admission, independently of app clocks. */
export const usageHistoryState = pgTable("usage_history_state", {
  id: text("id").primaryKey(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  retentionBeforeDay: date("retention_before_day", { mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})
