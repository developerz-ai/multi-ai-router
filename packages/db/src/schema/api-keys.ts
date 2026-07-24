import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { keyScope } from "./enums"

/**
 * A router-issued `mar_live_…` credential.
 *
 * Deliberately encrypted, not hashed, and never "shown once": the operator can
 * decrypt and copy the value from the admin plane at any time without rotating
 * it. Verification is prefix lookup -> decrypt -> constant-time compare, which
 * is why `prefix` is indexed and stored in clear.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Required, human-chosen: `sebastian-laptop`, `ci-agent-3`. */
    name: text("name").notNull(),

    /** AES-256-GCM ciphertext of the full key. Admin plane only, never the data plane. */
    value: text("value").notNull(),

    /** Short leading slice, in clear and indexed. Turns verification into one row fetch. */
    prefix: text("prefix").notNull(),

    scope: keyScope("scope").notNull().default("all"),

    /**
     * Per-key ceiling. NULL means no per-key limit.
     *
     * **Stored and carried, not yet enforced.** The verifier puts both values on `VerifiedKey`,
     * but no limiter reads them, so setting a limit today changes nothing about what a key can
     * do. Said plainly here rather than described as enforced, because a security control that
     * is documented as working and is not is worse than one that is absent.
     */
    rateLimitRequests: integer("rate_limit_requests"),
    rateLimitWindowSeconds: integer("rate_limit_window_seconds"),

    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),

    /** Excluded from verification immediately; the row is purged later by the janitor. */
    revoked: boolean("revoked").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),

    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // The verification hot path. Not unique: a prefix collision is possible and
    // is resolved by the constant-time compare, not by the index.
    index("api_keys_prefix_idx").on(table.prefix),
    index("api_keys_revoked_at_idx").on(table.revokedAt),
  ],
)

export type ApiKeyRow = typeof apiKeys.$inferSelect
export type NewApiKeyRow = typeof apiKeys.$inferInsert
