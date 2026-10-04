import {
  bigint,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"

/** Both tables carry event-time days; terminal requests are never counted per attempt group. */
function grain() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    day: date("day", { mode: "string" }).notNull(),
    apiKeyId: uuid("api_key_id"),
    accountId: uuid("account_id"),
    poolId: uuid("pool_id"),
    model: text("model"),
    basis: text("basis").$type<"live" | "legacy">().notNull(),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    costMetered: numeric("cost_metered", { precision: 24, scale: 6 }).notNull().default("0"),
    costNotional: numeric("cost_notional", { precision: 24, scale: 6 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  }
}
export const usageAttemptDailyV2 = pgTable("usage_attempt_daily_v2", grain(), (table) => [
  unique("usage_attempt_daily_v2_grain")
    .on(table.day, table.apiKeyId, table.accountId, table.poolId, table.model, table.basis)
    .nullsNotDistinct(),
  index("usage_attempt_daily_v2_day").on(table.day),
])
export const usageRequestDailyV2 = pgTable("usage_request_daily_v2", grain(), (table) => [
  unique("usage_request_daily_v2_grain")
    .on(table.day, table.apiKeyId, table.accountId, table.poolId, table.model, table.basis)
    .nullsNotDistinct(),
  index("usage_request_daily_v2_day").on(table.day),
])
