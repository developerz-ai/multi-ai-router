import { index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { apiKeys } from "./api-keys"
import { costBasis, providerId, type UsageOutcome } from "./enums"

/**
 * One row per upstream **attempt**, not per client request. A failover chain of
 * three accounts emits three rows sharing one `correlationId`; totals must count
 * the client request once and the attempts separately, or the numbers look wrong.
 *
 * Rows are enqueued in memory and batch-written off the request path — nothing
 * here is ever on the critical path.
 *
 * The account/key references are nullable with ON DELETE SET NULL: revoked keys
 * are purged 30 days after revocation while their historical rows stay, and an
 * attempt that failed before selection (no candidate in scope) has no account.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Shared by every attempt belonging to one client request. */
    correlationId: uuid("correlation_id").notNull(),
    /** 1-based position in the failover chain. */
    attempt: integer("attempt").notNull().default(1),

    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** Denormalized so the row survives the account it names. */
    provider: providerId("provider"),

    sessionKey: text("session_key"),

    /** The model the client asked for. Never substituted, only aliased per account. */
    model: text("model").notNull(),

    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /** Total prompt size is tokensIn + cacheWriteTokens + cacheReadTokens — always the sum. */
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** Cache creation tokens. */
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),

    /** NULL for an unknown model — never silently zero, never guessed. */
    costEstimate: numeric("cost_estimate", { precision: 14, scale: 6 }),
    costBasis: costBasis("cost_basis").notNull().default("unknown"),

    /** Total router-observed latency of the attempt. */
    latencyMs: integer("latency_ms").notNull().default(0),
    /** Time added by the router itself. Budgeted at <5 ms p99; a regression is a bug. */
    routerOverheadMs: integer("router_overhead_ms").notNull().default(0),

    /**
     * `success`, or the `RouterErrorCode` that ended the attempt. Text rather
     * than a Postgres enum so core can add an error code without a migration,
     * but typed against core so a typo is a compile error.
     */
    outcome: text("outcome").$type<UsageOutcome>().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // "Who burned what, in this window" — per key and per account, by day.
    index("usage_records_api_key_created_idx").on(table.apiKeyId, table.createdAt),
    index("usage_records_account_created_idx").on(table.accountId, table.createdAt),
    // Reassembling one client request from its attempts.
    index("usage_records_correlation_idx").on(table.correlationId),
    index("usage_records_session_key_idx").on(table.sessionKey),
    // The retention sweep deletes by age in bounded batches.
    index("usage_records_created_at_idx").on(table.createdAt),
  ],
)

export type UsageRecordRow = typeof usageRecords.$inferSelect
export type NewUsageRecordRow = typeof usageRecords.$inferInsert
