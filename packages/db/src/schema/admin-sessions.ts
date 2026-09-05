import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Admin console sessions, made durable. One row per live session, so a restart, a redeploy, or a
 * crash no longer logs the operator out, and a second replica can honour a cookie the first one
 * issued (`apps/api/src/services/admin-auth/postgresSessionStore.ts`).
 *
 * **The cookie value is the bearer, so the row must not contain it.** The primary key is the
 * SHA-256 of the opaque session id, never the id itself: a database dump yields nothing that can
 * be pasted into a cookie. Lookup hashes the presented id and reads by the hash — an indexed point
 * read, exactly like the plaintext would have been.
 *
 * Both expiry bounds are stored as instants rather than as the TTLs that produced them, so the
 * purge needs no configuration to decide what is dead and a TTL change never reinterprets rows
 * minted under the old one.
 */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    /** SHA-256 hex of the opaque session id. The id itself is never written. */
    idHash: text("id_hash").primaryKey(),
    username: text("username").notNull(),

    /**
     * Stored as-is, deliberately. The synchronizer token is handed back to the SPA on every session
     * read (it has to compare the header against it), so a hash here would make the store unable to
     * answer. It is also worthless on its own: CSRF protection only matters to a request that
     * already carries the cookie, and the cookie is what this table refuses to store.
     */
    csrfToken: text("csrf_token").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Sliding: rewritten on a coalesced idle-window slide. */
    idleExpiryAt: timestamp("idle_expiry_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Fixed at login: no amount of activity extends it. */
    absoluteExpiryAt: timestamp("absolute_expiry_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  // The purge's two predicates: a session is dead once *either* bound has passed, and Postgres
  // answers `a <= t OR b <= t` with a bitmap-or over two indexes but not with one.
  (table) => [
    index("admin_sessions_idle_expiry_at_idx").on(table.idleExpiryAt),
    index("admin_sessions_absolute_expiry_at_idx").on(table.absoluteExpiryAt),
  ],
)

export type AdminSessionRow = typeof adminSessions.$inferSelect
export type NewAdminSessionRow = typeof adminSessions.$inferInsert
