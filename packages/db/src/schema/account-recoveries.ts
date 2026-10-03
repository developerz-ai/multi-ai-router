import { sql } from "drizzle-orm"
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
export type RecoveryState =
  | "pending"
  | "issued"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled"
export type RecoveryReason =
  | "operator-recheck"
  | "operator-enable"
  | "authentication-recovered"
  | "cooldown-expired"
  | "quota-stale"
export const accountRecoveries = pgTable(
  "account_recoveries",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    generation: uuid("generation").notNull(),
    revision: integer("revision").notNull().default(0),
    lifecycleVersion: integer("lifecycle_version").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    state: text("state").$type<RecoveryState>().notNull().default("pending"),
    reason: text("reason").$type<RecoveryReason>().notNull(),
    ownerBootId: uuid("owner_boot_id"),
    ownershipEpoch: integer("ownership_epoch").notNull().default(0),
    preparationLeaseUntil: timestamp("preparation_lease_until", {
      withTimezone: true,
      mode: "date",
    }),
    permitId: uuid("permit_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
    outcomeAt: timestamp("outcome_at", { withTimezone: true, mode: "date" }),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).notNull(),
    nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true, mode: "date" }).notNull(),
    quotaRevisions: jsonb("quota_revisions").$type<Record<string, number>>().notNull(),
  },
  (table) => [
    check("account_recoveries_revision_nonnegative", sql`${table.revision} >= 0`),
    check("account_recoveries_epoch_nonnegative", sql`${table.ownershipEpoch} >= 0`),
    check(
      "account_recoveries_state_valid",
      sql`${table.state} in ('pending','issued','succeeded','failed','uncertain','cancelled')`,
    ),
    check(
      "account_recoveries_permit_valid",
      sql`(${table.state} = 'pending' and ${table.permitId} is null and ${table.issuedAt} is null) or (${table.state} in ('issued','succeeded','failed','uncertain') and ${table.permitId} is not null and ${table.issuedAt} is not null and ${table.ownerBootId} is not null) or ${table.state} = 'cancelled'`,
    ),
  ],
)
export type RecoveryRow = typeof accountRecoveries.$inferSelect
