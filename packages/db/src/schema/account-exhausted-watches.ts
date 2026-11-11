import { sql } from "drizzle-orm"
import { check, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"

/**
 * The bounded re-test ladder of an `exhausted` account (CLAUDE.md rule 7): how many re-tests it
 * has had, when the next is due, and when the last ran. Persisted rather than held per process
 * because the advisory lock hands each `cooldown_recheck` tick to whichever replica wins it, and
 * a restart must not reset a week-long park to its first, one-hour step.
 *
 * One row per watched account; the row goes with its account (`ON DELETE CASCADE`). The schedule
 * itself (`services/routing/exhausted-retest.ts`) stays a pure step over this state.
 */
export const accountExhaustedWatches = pgTable(
  "account_exhausted_watches",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Re-tests spent since the watch began. */
    retests: integer("retests").notNull(),
    /** When the next re-test is due. */
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
    /** The last re-test, or NULL before the first. */
    lastRetestAt: timestamp("last_retest_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [check("account_exhausted_watches_retests_nonnegative", sql`${table.retests} >= 0`)],
)

export type AccountExhaustedWatchRow = typeof accountExhaustedWatches.$inferSelect
