import { sql } from "drizzle-orm"
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"

/** What one proxy check concluded. Only a vendor listing or a CONNECT probe produces one. */
export const EGRESS_PROXY_OUTCOMES = [
  "ok",
  "auth",
  "unreachable",
  "timeout",
  "refused",
  "not_listed",
  "vendor_invalid",
] as const
export type EgressProxyOutcome = (typeof EGRESS_PROXY_OUTCOMES)[number]

/** Where the dead-proxy repair of one account stands. */
export const EGRESS_REPAIR_STATES = [
  "idle",
  "cooldown",
  "no_candidate",
  "vendor_unavailable",
] as const
export type EgressRepairState = (typeof EGRESS_REPAIR_STATES)[number]

/**
 * Proxy health of one account's egress proxy, written only by `egress_proxy_check` and the
 * operator's own test. Nothing on the data plane feeds it (docs/idea/03-providers.md#egress-proxy).
 *
 * `assignment` names the proxy the row is about (sha256 hex of `egress_proxy.sealed`). Assigning or
 * clearing a proxy writes nothing here: a row whose assignment no longer matches reads as zero
 * failures, and the next check resets it. `last_swap_at` and `swaps` survive reassignment because
 * they are the swap cooldown, which belongs to the account and not to a proxy.
 */
export const accountEgressHealth = pgTable(
  "account_egress_health",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    assignment: text("assignment").notNull(),
    lastOutcome: text("last_outcome").$type<EgressProxyOutcome>(),
    /** The proxy's CONNECT status when it answered one. */
    lastStatus: integer("last_status"),
    latencyMs: integer("latency_ms"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true, mode: "date" }),
    repair: text("repair").$type<EgressRepairState>().notNull().default("idle"),
    lastSwapAt: timestamp("last_swap_at", { withTimezone: true, mode: "date" }),
    swaps: integer("swaps").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "account_egress_health_outcome_known",
      sql`${table.lastOutcome} in ('ok', 'auth', 'unreachable', 'timeout', 'refused', 'not_listed', 'vendor_invalid')`,
    ),
    check("account_egress_health_failures_nonnegative", sql`${table.consecutiveFailures} >= 0`),
    check(
      "account_egress_health_repair_known",
      sql`${table.repair} in ('idle', 'cooldown', 'no_candidate', 'vendor_unavailable')`,
    ),
    check("account_egress_health_swaps_nonnegative", sql`${table.swaps} >= 0`),
  ],
)

export type AccountEgressHealthRow = typeof accountEgressHealth.$inferSelect
