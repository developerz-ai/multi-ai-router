import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * The local admin credential: at most one row, holding the argon2id hash of the
 * operator-chosen console password written by `bin/admin set-password`.
 *
 * The row's *existence* is the on/off switch — there is no enable flag anywhere
 * (issue #52: a fresh database has no row, and the door is off). Deleting the
 * row (`bin/admin delete-password`) closes the door again.
 *
 * **Hash in, hash out.** The plaintext password never crosses this boundary:
 * the service layer hashes before `upsertHash` and verifies after `get`. What
 * is stored here is an argon2id PHC string — one-way, so this table is
 * deliberately NOT wrapped in the AES-256-GCM envelope every other credential
 * column uses. A database dump yields a hash to grind offline, not a password
 * (docs/idea/13-admin-oidc.md).
 *
 * Single-principal by design: one row, addressed by a fixed singleton id, never
 * a user table.
 */
export const adminCredentials = pgTable("admin_credentials", {
  /** Fixed singleton value — see `ADMIN_CREDENTIAL_SINGLETON` in the repository. */
  id: text("id").primaryKey(),

  /** argon2id PHC string (`$argon2id$v=19$…`). Never a plaintext password. */
  passwordHash: text("password_hash").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
})

export type AdminCredentialRow = typeof adminCredentials.$inferSelect
export type NewAdminCredentialRow = typeof adminCredentials.$inferInsert
