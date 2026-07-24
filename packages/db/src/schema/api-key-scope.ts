import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { apiKeys } from "./api-keys"
import { pools } from "./pools"

/**
 * Scope targets, one table per target kind.
 *
 * `scope = 'all'` has no rows in either table. `scope = 'pools'` names pools;
 * `scope = 'accounts'` names accounts directly, ignoring pool membership.
 * Selection is always the *intersection* of the pool's members and the key's
 * scope — a key can never reach an account outside it, and an empty
 * intersection is an error naming the reason, never a silent widening.
 */
export const apiKeyPools = pgTable(
  "api_key_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("api_key_pools_key_pool_key").on(table.apiKeyId, table.poolId),
    index("api_key_pools_pool_idx").on(table.poolId),
  ],
)

export const apiKeyAccounts = pgTable(
  "api_key_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("api_key_accounts_key_account_key").on(table.apiKeyId, table.accountId),
    index("api_key_accounts_account_idx").on(table.accountId),
  ],
)

export type ApiKeyPoolRow = typeof apiKeyPools.$inferSelect
export type NewApiKeyPoolRow = typeof apiKeyPools.$inferInsert
export type ApiKeyAccountRow = typeof apiKeyAccounts.$inferSelect
export type NewApiKeyAccountRow = typeof apiKeyAccounts.$inferInsert
