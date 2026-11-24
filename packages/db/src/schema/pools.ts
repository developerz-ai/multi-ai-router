import {
  DEFAULT_ACCOUNT_PRIORITY,
  DEFAULT_ACCOUNT_WEIGHT,
  DEFAULT_ROUTING_POLICY,
} from "@multi-ai-router/core"
import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
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
     * when every other member has filtered out. Invisible to the policy until
     * then (docs/idea/05-routing-and-failover.md#overflow-optional-opt-in).
     *
     * It must be one of the pool's `pool_members`. Candidates are
     * `pool_members ∩ key_scope` and nothing widens that, so an overflow outside
     * the membership would let a key scoped to this pool reach an account the
     * pool does not hold. The rule is enforced by `services/pools` at write time
     * and by `services/routing/scope.ts` at read time; a composite foreign key
     * would state it here, but `replaceMembers` empties the membership mid
     * transaction and the cascade a dropped membership needs is `set null` on
     * one column of two, which a composite reference cannot express.
     *
     * `ON DELETE SET NULL`: deleting the overflow account must drop the pool's
     * fallback, never the pool.
     */
    overflowAccountId: uuid("overflow_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),

    /**
     * When the pool last became memberless; `NULL` while it has a member. The `pool_reap` task
     * deletes a pool still empty `RETENTION_EMPTY_POOL_DAYS` after this.
     *
     * Kept by triggers on `pool_members` (migration 0047), not by `services/pools`, because the
     * membership also drops through `ON DELETE CASCADE` when an account is deleted — a write no
     * service sees. The default is the creation instant: a pool created with no members has been
     * empty since it existed, and the first member insert clears it.
     */
    emptySince: timestamp("empty_since", { withTimezone: true, mode: "date" }).defaultNow(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),

    /**
     * Universal per-pool soft utilization limit. A member at or above it ranks behind
     * members with headroom remaining; enforced by selection/filter regardless of the
     * pool's routing policy. Default 0.8 so no pool changes behavior until an operator
     * sets a lower value. No key state, model assignment, key scope, or alert threshold
     * changes with it.
     */
    quotaSoftLimit: numeric("quota_soft_limit").notNull().default("0.80"),
  },
  (table) => [uniqueIndex("pools_name_key").on(table.name)],
)

/**
 * Account <-> Pool is many-to-many: an account may sit in several pools, and the
 * weight/priority it carries are properties of *that membership*, not of the
 * account globally.
 *
 * The two defaults below are only ever reached by a row this schema writes on
 * its own — a `pool_members` row written through `services/pools` always states
 * both, resolved from the write, the membership it replaces, or the account
 * (see that service's `resolveTuning`). Membership is replaced as a whole set,
 * so a default that could win would mean every pool edit silently re-flattened
 * the pool's tuning.
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
    weight: integer("weight").notNull().default(DEFAULT_ACCOUNT_WEIGHT),
    priority: integer("priority").notNull().default(DEFAULT_ACCOUNT_PRIORITY),
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
