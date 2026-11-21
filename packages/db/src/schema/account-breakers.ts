import { sql } from "drizzle-orm"
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { accountStatus, resetSource } from "./enums"

export const accountBreakers = pgTable(
  "account_breakers",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    lifecycleVersion: integer("lifecycle_version").notNull(),
    healthRecoveryVersion: integer("health_recovery_version").notNull(),
    authRecoveryVersion: integer("auth_recovery_version").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    status: accountStatus("status").notNull(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true, mode: "date" }),
    cooldownSource: resetSource("cooldown_source").notNull(),
    cooldownReason: text("cooldown_reason").$type<"credential-rejected">(),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    /** A probe in flight on some replica; the durable half of the half-open gate. */
    probeHeldUntil: timestamp("probe_held_until", { withTimezone: true, mode: "date" }),
    capturedGeneration: uuid("captured_generation"),
  },
  (table) => [
    check(
      "account_breakers_counts_valid",
      sql`${table.revision} >= 0 and ${table.consecutiveFailures} >= 0 and ${table.lifecycleVersion} >= 0 and ${table.healthRecoveryVersion} >= 0 and ${table.authRecoveryVersion} >= 0`,
    ),
    check(
      "account_breakers_clock_valid",
      sql`(${table.status} = 'cooling_down' and ${table.cooldownUntil} is not null) or (${table.status} <> 'cooling_down' and ${table.cooldownUntil} is null)`,
    ),
    check(
      "account_breakers_reason_valid",
      sql`${table.cooldownReason} is null or (${table.cooldownReason} = 'credential-rejected' and ${table.status} = 'cooling_down')`,
    ),
    // A probe hold only means something on an account that is mid-recovery: outside `cooling_down`
    // there is no probe to admit and a stale hold would park a healthy account.
    check(
      "account_breakers_probe_hold_valid",
      sql`${table.probeHeldUntil} is null or ${table.status} = 'cooling_down'`,
    ),
  ],
)
export type AccountBreakerRow = typeof accountBreakers.$inferSelect
