import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"

/** Short-lived exclusion around an external CLI check; no DB lock crosses the check. */
export const accountOperatorChecks = pgTable("account_operator_checks", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  claimToken: uuid("claim_token").notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }).notNull(),
})
