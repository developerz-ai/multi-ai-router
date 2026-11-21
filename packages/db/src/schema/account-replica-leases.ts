import { sql } from "drizzle-orm"
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export type ReplicaLeaseState = "attaching" | "ready" | "draining" | "released"

// Deliberately no account FK: provisioning precedes insertion and deletion cannot reset fencing.
export const accountReplicaLeases = pgTable(
  "account_replica_leases",
  {
    accountId: uuid("account_id").primaryKey(),
    owner: uuid("owner").notNull(),
    generation: bigint("generation", { mode: "bigint" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    storageIdentity: text("storage_identity"),
    state: text("state").$type<ReplicaLeaseState>().notNull(),
  },
  (table) => [
    index("account_replica_leases_expiry_idx").on(table.expiresAt),
    check("account_replica_leases_generation", sql`${table.generation} > 0`),
    check(
      "account_replica_leases_state",
      sql`${table.state} in ('attaching','ready','draining','released')`,
    ),
    check(
      "account_replica_leases_storage",
      sql`${table.storageIdentity} is null or length(${table.storageIdentity}) between 1 and 512`,
    ),
    check(
      "account_replica_leases_ready",
      sql`${table.state} <> 'ready' or ${table.storageIdentity} is not null`,
    ),
  ],
)
export type AccountReplicaLeaseRow = typeof accountReplicaLeases.$inferSelect
