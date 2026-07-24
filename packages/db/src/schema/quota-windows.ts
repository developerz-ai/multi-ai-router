import type { QuotaWindowKind } from "@multi-ai-router/core"
import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { resetSource, utilizationSource } from "./enums"

/**
 * One row per account per quota window. Windows reset independently and the
 * account is blocked by whichever one is spent, so this is never one number.
 *
 * The row carries the answer *and* how trustworthy it is: `utilization` is
 * nullable on purpose (a threshold-triggered source reports nothing for most of
 * a window — that is a normal reading, not a fault) and both source columns are
 * always displayed beside the value.
 *
 * An `exhausted` account has no reset by definition: `resetsAt` stays NULL and
 * the UI shows "needs top-up", never a countdown.
 */
export const quotaWindows = pgTable(
  "quota_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),

    /**
     * `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, or a
     * provider-specific window. Text rather than a Postgres enum, and typed
     * against core for the same reason as `usageRecords.outcome`: this column
     * labels a bucket a provider reports, and observing a kind we have not seen
     * before should cost a core change, not a core change *and* a migration.
     */
    window: text("window").$type<QuotaWindowKind>().notNull(),

    /** Fraction of the window consumed, 0..1. NULL is a valid, expected reading. */
    utilization: doublePrecision("utilization"),
    utilizationSource: utilizationSource("utilization_source").notNull().default("none"),

    resetsAt: timestamp("resets_at", { withTimezone: true, mode: "date" }),
    resetSource: resetSource("reset_source").notNull().default("unknown"),

    /** Rendered next to every utilization figure — a gauge without it is unreadable. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("quota_windows_account_window_key").on(table.accountId, table.window),
    index("quota_windows_resets_at_idx").on(table.resetsAt),
  ],
)

export type QuotaWindowRow = typeof quotaWindows.$inferSelect
export type NewQuotaWindowRow = typeof quotaWindows.$inferInsert
