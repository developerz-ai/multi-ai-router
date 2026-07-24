import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { apiKeys } from "./api-keys"

/**
 * Prefix hashes plus per-message SDK assistant UUIDs, used to classify the next
 * request as continuation / compaction / undo / diverged before resuming.
 */
export interface SessionLineageState {
  readonly prefixHashes: readonly string[]
  readonly assistantUuids: readonly string[]
}

/** How the session key was obtained, when it was not supplied by the client. */
export type SessionFingerprintSource = "header" | "fingerprint"

/**
 * Conversation identity, for routing and usage attribution.
 *
 * On the Claude subscription (Agent-SDK) path this row is **persisted truth,
 * not a cache**: an SDK session id is resumable only on the account that
 * created it, so `accountId` records a fact about where the conversation
 * physically lives upstream. Selection reads it as an input and returns it; no
 * policy may overrule it and no hash can recompute it.
 *
 * On the plain HTTP path `accountId` and `sdkSessionId` stay NULL — placement
 * is recomputed by rendezvous hashing and hopping costs only a cold cache.
 *
 * When the bound account becomes unusable the binding is *invalidated*, never
 * moved: the FK's ON DELETE SET NULL is the backstop for a deleted account, and
 * the service clears `sdkSessionId` and `lineageState` with it.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Client-supplied session header verbatim, else the derived fingerprint. */
    key: text("key").notNull(),

    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),

    /** The binding. SDK path only: persisted, authoritative, scoped to this account. */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),

    /** SDK path only. Meaningful only in the context of `accountId`; never carried elsewhere. */
    sdkSessionId: text("sdk_session_id"),

    lineageState: jsonb("lineage_state").$type<SessionLineageState>(),

    fingerprintSource: text("fingerprint_source").$type<SessionFingerprintSource>(),

    /** Drives the idle expiry sweep. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // The lookup: a session key is scoped to the key that owns it.
    uniqueIndex("sessions_api_key_key_key").on(table.apiKeyId, table.key),
    index("sessions_account_idx").on(table.accountId),
    index("sessions_last_used_at_idx").on(table.lastUsedAt),
  ],
)

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
