import {
  bigint,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * Daily rollup of `usageRecords`, written hourly and idempotent per
 * (day, key, account, model) — a re-run upserts the same row.
 *
 * Every aggregate the dashboard shows is read from here; raw rows are scanned
 * only for today's partial day. Raw rows expire on the retention window while
 * this table does not, which is why the key/account columns are plain UUIDs
 * with **no foreign key**: a lifetime total must survive the purge of the key
 * that earned it.
 *
 * Metered and notional spend are separate columns because they are never summed
 * — a subscription account has no per-token price, only an attribution.
 */
export const usageDaily = pgTable(
  "usage_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** UTC day. */
    day: date("day", { mode: "string" }).notNull(),
    apiKeyId: uuid("api_key_id").notNull(),
    accountId: uuid("account_id").notNull(),
    model: text("model").notNull(),

    /** Client-facing requests. */
    requests: integer("requests").notNull().default(0),
    /** Upstream attempts. Always reported beside `requests`, never merged into it. */
    attempts: integer("attempts").notNull().default(0),
    errors: integer("errors").notNull().default(0),

    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),

    costMetered: numeric("cost_metered", { precision: 16, scale: 6 }).notNull().default("0"),
    costNotional: numeric("cost_notional", { precision: 16, scale: 6 }).notNull().default("0"),

    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_daily_grain_key").on(
      table.day,
      table.apiKeyId,
      table.accountId,
      table.model,
    ),
    index("usage_daily_day_idx").on(table.day),
    index("usage_daily_account_day_idx").on(table.accountId, table.day),
  ],
)

export type UsageDailyRow = typeof usageDaily.$inferSelect
export type NewUsageDailyRow = typeof usageDaily.$inferInsert
