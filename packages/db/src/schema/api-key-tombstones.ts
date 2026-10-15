import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { keyOwnerKind } from "./enums"

/**
 * What a purged key leaves behind: its attribution, never its secret.
 *
 * `usage_records` and the rollups keep a key's id long after the `api_keys` row is gone (no FK
 * since 0030), so a name source that outlives the row is what lets a report still say whose spend
 * a month-old rotation was. Written in the same statement as the delete (janitor purge) or the same
 * transaction (operator delete) and swept on `RETENTION_USAGE_DAILY_DAYS`, the horizon of the
 * rollups it labels.
 *
 * Deliberately has no `value`/ciphertext column, and nothing on the request path reads this table:
 * verification, reveal and the admin key list all stay on `api_keys`. The display prefix is
 * non-secret (docs/idea/07-security.md).
 */
export const apiKeyTombstones = pgTable(
  "api_key_tombstones",
  {
    /** The purged key's id — no default and no FK: it names a row that no longer exists. */
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    owner: text("owner"),
    ownerKind: keyOwnerKind("owner_kind"),
    tool: text("tool"),
    /** From the caller's injected clock, never the database's `now()`. */
    purgedAt: timestamp("purged_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("api_key_tombstones_purged_at_idx").on(table.purgedAt)],
)

export type ApiKeyTombstoneRow = typeof apiKeyTombstones.$inferSelect
