import type { UsageReportDeliveryStatus } from "@multi-ai-router/core"
import { date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

/**
 * One stored weekly usage report per UTC Monday-to-Monday week (issue #227).
 *
 * `period_start` is the Monday the week begins and is unique: it is the idempotency key, so two
 * generations that bypass the scheduler's advisory lock (two replicas, a restart mid-tick) still
 * leave one row (`INSERT ... ON CONFLICT (period_start) DO NOTHING`). `period_end` is the exclusive
 * end, the following Monday.
 *
 * `payload` is everything a delivery needs, so delivery (#229) never re-reads live state. It never
 * carries an account label (they are often email addresses): the shape is
 * `apps/api/src/services/usage-report/types.ts`.
 *
 * **`delivery_status` is `text`, not a Postgres enum, on purpose.** A Postgres enum value can never
 * be removed, and delivery (#229) is expected to want its own states; typing the column against the
 * core union instead means adding one is a core change with no migration. This stretches the
 * `enums.ts` header convention, which is written for labels a provider reports; the reason here is
 * only that #229 should not need a second one-way enum. A new report starts `pending`.
 *
 * Swept by the janitor on `period_start`, strictly older than `RETENTION_USAGE_REPORTS_DAYS`, which
 * boot refuses to set below 14: the task regenerates a missing last-complete week, so a row swept
 * while its week is still the target would be generated (and, once delivery lands, sent) again.
 */
export const usageReports = pgTable("usage_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  periodStart: date("period_start", { mode: "string" }).notNull().unique(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" }).notNull(),
  payload: jsonb("payload").$type<unknown>().notNull(),
  deliveryStatus: text("delivery_status")
    .$type<UsageReportDeliveryStatus>()
    .notNull()
    .default("pending"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  /** The last delivery failure's message, redacted. Never credential material. */
  lastError: text("last_error"),
})

export type UsageReportRow = typeof usageReports.$inferSelect
export type NewUsageReportRow = typeof usageReports.$inferInsert
