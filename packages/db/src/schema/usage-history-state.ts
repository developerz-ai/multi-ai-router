import { sql } from "drizzle-orm"
import { bigint, check, date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
/** Accounted source revisions serialize maintenance with admission, independently of app clocks. */
export const usageHistoryState = pgTable(
  "usage_history_state",
  {
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
     * Banked-through watermark W (#275): every `usage_records` row at or before `(created_at, id)` of
     * this pair AND at or above `retentionBeforeDay` has a non-pending contribution (retention is
     * safe because the pending scan is floored at the horizon anyway). Written only by `backfill`,
     * and only after a sweep that began with no resume cursor ended short of its limit with no
     * `legacy_overlap` adoption, so the table was provably clean inside that transaction. The proof
     * holds against every writer that takes the history lock; a lock-free pre-2.16 writer during a
     * rolling upgrade is outside it (remedy: NULL both columns). `coverage` runs its `pending`
     * check over the rows after the pair only. Both NULL means no proof yet: scan everything; the
     * CHECK forbids exactly one being NULL.
     */
    bankedThroughAt: timestamp("banked_through_at", { withTimezone: true, mode: "date" }),
    bankedThroughId: uuid("banked_through_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "usage_history_state_watermark_paired",
      sql`(${table.bankedThroughAt} is null) = (${table.bankedThroughId} is null)`,
    ),
  ],
)
