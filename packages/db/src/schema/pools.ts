import { DEFAULT_ROUTING_POLICY } from "@multi-ai-router/core"
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { routingPolicy } from "./enums"

export const pools = pgTable(
  "pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    policy: routingPolicy("policy").notNull().default(DEFAULT_ROUTING_POLICY),

    /**
     * The pool's member of last resort — typically a paid API key — engaged only
     * when every ordinary member has filtered out. Invisible to the policy until
     * then, and still subject to the presenting key's scope
     * (docs/idea/05-routing-and-failover.md#overflow-optional-opt-in).
     *
     * `ON DELETE SET NULL`: deleting the overflow account must drop the pool's
     * fallback, never the pool.
     */
    overflowAccountId: uuid("overflow_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pools_name_key").on(table.name)],
)

/**
 * Account <-> Pool is many-to-many: an account may sit in several pools, and the
 * weight/priority it carries are properties of *that membership*, not of the
 * account globally.
 */
export const poolMembers = pgTable(
  "pool_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    weight: integer("weight").notNull().default(100),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pool_members_pool_account_key").on(table.poolId, table.accountId),
    index("pool_members_account_idx").on(table.accountId),
  ],
)

export type PoolRow = typeof pools.$inferSelect
export type NewPoolRow = typeof pools.$inferInsert
export type PoolMemberRow = typeof poolMembers.$inferSelect
export type NewPoolMemberRow = typeof poolMembers.$inferInsert
