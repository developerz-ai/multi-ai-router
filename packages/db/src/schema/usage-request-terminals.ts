import { index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { providerId, type UsageOutcome } from "./enums"

/** One immutable logical settlement, separate from the immutable upstream attempts. */
export const usageRequestTerminals = pgTable(
  "usage_request_terminals",
  {
    correlationId: uuid("correlation_id").primaryKey(),
    winnerEventId: uuid("winner_event_id"),
    apiKeyId: uuid("api_key_id"),
    accountId: uuid("account_id"),
    poolId: uuid("pool_id"),
    provider: providerId("provider"),
    model: text("model"),
    upstreamModel: text("upstream_model"),
    outcome: text("outcome").$type<UsageOutcome>().notNull(),
    errorClass: text("error_class"),
    responseStatus: smallint("response_status"),
    httpStatus: smallint("http_status"),
    attributionKind: text("attribution_kind")
      .$type<"winning-attempt" | "unstarted" | "abandoned">()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("usage_request_terminals_settled_idx").on(table.settledAt)],
)
export type UsageRequestTerminalRow = typeof usageRequestTerminals.$inferSelect
export type UsageRequestTerminalInsert = Omit<
  typeof usageRequestTerminals.$inferInsert,
  "ingestedAt"
> & { readonly correlationId: string }
