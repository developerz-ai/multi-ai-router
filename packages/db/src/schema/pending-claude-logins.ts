import { sql } from "drizzle-orm"
import { bigint, check, pgTable, timestamp, uuid } from "drizzle-orm/pg-core"

// Deliberately no account FK: a pending claim must never be invalidated by account lifecycle writes.
export const accountPendingClaudeLogins = pgTable(
  "account_pending_claude_logins",
  {
    accountId: uuid("account_id").primaryKey(),
    owner: uuid("owner").notNull(),
    generation: bigint("generation", { mode: "bigint" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [check("account_pending_claude_logins_generation", sql`${table.generation} > 0`)],
)
export type PendingClaudeLoginRow = typeof accountPendingClaudeLogins.$inferSelect
