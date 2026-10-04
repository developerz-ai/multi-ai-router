import { date, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"

/** Compact durable idempotency facts survive raw retention; never expire ahead of history. */
export interface UsageContribution {
  apiKeyId: string | null
  accountId: string | null
  poolId: string | null
  model: string | null
  correlationId: string
  eventAt: string
  attempts: number
  requests: number
  errors: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMetered: string
  costNotional: string
}
export const usageContributions = pgTable(
  "usage_contributions",
  {
    id: uuid("id").notNull(),
    kind: text("kind").$type<"attempt" | "terminal">().notNull(),
    day: date("day", { mode: "string" }).notNull(),
    source: text("source")
      .$type<"live" | "legacy_pending" | "legacy_baseline" | "legacy_unbanked" | "legacy_overlap">()
      .notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<UsageContribution>().notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.id] }),
    index("usage_contributions_day_idx").on(table.day),
    index("usage_contributions_source_idx").on(table.source, table.id),
  ],
)
