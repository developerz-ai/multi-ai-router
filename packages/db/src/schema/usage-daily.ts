import { sql } from "drizzle-orm"
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
    /**
     * The pool whose policy placed the request. NULL when the presenting key's scope resolved
     * outside any pool, which is the normal case for a scope of `all`.
     *
     * Part of the grain, not a decoration: "is my routing policy doing what I set it to" is a
     * per-pool question, an account belongs to many pools, and membership changes over time — so
     * it cannot be recovered by joining after the fact. Raw rows expire on the retention window,
     * so if the rollup does not carry it the answer becomes unavailable rather than merely slow.
     */
    poolId: uuid("pool_id"),
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
    // `coalesce` rather than the bare column: in Postgres two NULLs are distinct, so a plain
    // unique index over a nullable `pool_id` would let the hourly rollup insert a duplicate
    // "no pool" row on every run instead of upserting the existing one — silently doubling every
    // unscoped total. `NULLS NOT DISTINCT` would be the direct expression of this and is not
    // reachable through drizzle's `uniqueIndex`, so the sentinel does the same job explicitly.
    uniqueIndex("usage_daily_grain_key").on(
      table.day,
      table.apiKeyId,
      table.accountId,
      sql`coalesce(${table.poolId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.model,
    ),
    index("usage_daily_day_idx").on(table.day),
    index("usage_daily_account_day_idx").on(table.accountId, table.day),
  ],
)

export type UsageDailyRow = typeof usageDaily.$inferSelect
export type NewUsageDailyRow = typeof usageDaily.$inferInsert
