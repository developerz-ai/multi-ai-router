import type { Dialect, EgressMode } from "@multi-ai-router/core"
import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { apiKeys } from "./api-keys"
import { costBasis, providerId, type UsageOutcome } from "./enums"
import { pools } from "./pools"

/**
 * One row per upstream **attempt**, not per client request. A failover chain of
 * three accounts emits three rows sharing one `correlationId`; totals must count
 * the client request once and the attempts separately, or the numbers look wrong.
 *
 * Rows are enqueued in memory and batch-written off the request path — nothing
 * here is ever on the critical path.
 *
 * The account/key/pool references are nullable with ON DELETE SET NULL: revoked
 * keys are purged 30 days after revocation while their historical rows stay, and
 * an attempt that failed before selection (no candidate in scope) has no account.
 *
 * Every column added after the first release is nullable, and NULL means exactly
 * *unknown or not applicable* — a row written before the column existed, or an
 * attempt that never got far enough to have the fact. Backfilling an invented
 * value would put a number in a report that nobody measured.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Shared by every attempt belonging to one client request. **Router-owned**,
     * always a UUID, never the client's `x-request-id` — see `clientRequestId`.
     */
    correlationId: uuid("correlation_id").notNull(),
    /**
     * The `x-request-id` the client supplied, verbatim, when it supplied one.
     *
     * NULL when the router minted the id itself, which is the common case. This
     * is a **trace** field, not a join key: it is caller-controlled, so it is
     * neither unique nor trustworthy, and two clients both sending `req-1` must
     * not have their attempt chains merged. It exists so "my request req-42
     * failed" is answerable at all, which it was not while the value was only
     * ever on a log line.
     */
    clientRequestId: text("client_request_id"),
    /** 1-based position in the failover chain. */
    attempt: integer("attempt").notNull().default(1),

    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /**
     * The pool the account was selected *from*. Not derivable by joining: an
     * account belongs to many pools, and which one was in play is a property of
     * the presenting key's scope at request time. NULL when the key's scope was
     * `all` or an explicit account list, so no pool was involved.
     */
    poolId: uuid("pool_id").references(() => pools.id, { onDelete: "set null" }),
    /** Denormalized so the row survives the account it names. */
    provider: providerId("provider"),

    sessionKey: text("session_key"),

    /** The model the client asked for. Never substituted, only aliased per account. */
    model: text("model").notNull(),
    /**
     * The name actually put on the wire, after the account's alias map. Equal to
     * `model` when no alias applied.
     *
     * A separate fact from `model`, not a derived one: the alias map is mutable
     * operator config, so re-deriving it later answers "what would we send now",
     * never "what did we send then" — and "the client asked for sonnet, we sent
     * glm-4.7" is the whole question a per-model cost line has to survive.
     */
    upstreamModel: text("upstream_model"),

    /** The API surface the client called. Nothing else on the row identifies it. */
    ingressDialect: text("ingress_dialect").$type<Dialect>(),
    /**
     * How the request reached the upstream: `passthrough`, `translate`, or
     * `agent-sdk`. The per-row twin of the `path` label on
     * `router_overhead_seconds` — an overhead regression is only actionable once
     * it is attributed to the path that caused it.
     *
     * Carried instead of an `egress_dialect` (the spec's wording): the fact worth
     * storing is the *relationship* between the two dialects, which a second
     * dialect column only expresses by comparison, and the SDK path has no egress
     * dialect to record at all.
     */
    egressMode: text("egress_mode").$type<EgressMode>(),

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
    /**
     * Time to the first relayed byte. NULL when no byte was ever relayed.
     *
     * This column is how "zero added time-to-first-token" stops being a promise
     * and becomes a measurement: `latencyMs` is dominated by generation time and
     * hides a buffering regression completely, while a TTFB that starts tracking
     * total latency is exactly what buffering a stream looks like from here.
     */
    ttfbMs: integer("ttfb_ms"),
    /** Time added by the router itself. Budgeted at <5 ms p99; a regression is a bug. */
    routerOverheadMs: integer("router_overhead_ms").notNull().default(0),

    /**
     * Whether bytes reached the client. A streamed attempt is never retried, so
     * this is the audit of that rule, and it splits the latency distributions
     * that are meaningless when mixed.
     */
    streamed: boolean("streamed").notNull().default(false),
    /** The upstream's status when it answered. NULL means we never reached it. */
    httpStatus: integer("http_status"),
    /**
     * The thrown class's name — never a message, never a body. Redundant with
     * `outcome` for a `RouterError`, and the only signal there is when `outcome`
     * is `router_error`: "3% failed as router_error" is unactionable until this
     * column says whether they were all one `TypeError`.
     */
    errorClass: text("error_class"),

    /**
     * How the attempt ended. Text rather than a Postgres enum so core can add an
     * outcome without a migration, but typed against core so a typo is a compile
     * error.
     */
    outcome: text("outcome").$type<UsageOutcome>().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Reassembling one client request from its attempts.
    index("usage_records_correlation_idx").on(table.correlationId),
    // "Find me request req-42". Partial, because the column is NULL on every row
    // whose id the router minted — which is nearly all of them — and this table
    // is the write-heaviest one in the schema.
    index("usage_records_client_request_idx")
      .on(table.clientRequestId)
      .where(sql`${table.clientRequestId} is not null`),
    // The retention sweep deletes by age in bounded batches.
    index("usage_records_created_at_idx").on(table.createdAt),
  ],
)

export type UsageRecordRow = typeof usageRecords.$inferSelect
export type NewUsageRecordRow = typeof usageRecords.$inferInsert
