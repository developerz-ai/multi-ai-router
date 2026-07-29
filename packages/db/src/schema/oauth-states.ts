import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import { providerId } from "./enums"

/**
 * One-shot OAuth `state` + PKCE verifier, bound to a pending account row and
 * purged on a short TTL. Server-side only: a mismatched or reused `state` is
 * rejected, which is why the row records when it was consumed rather than being
 * deleted inline.
 *
 * Claude subscription accounts do not use this table — their login is handed to
 * the `claude` CLI and lands in the account's `CLAUDE_CONFIG_DIR`.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state").notNull(),

    /** AES-256-GCM ciphertext of the PKCE `code_verifier`. */
    codeVerifier: text("code_verifier").notNull(),

    /**
     * AES-256-GCM ciphertext of the OIDC `nonce`. Null when the flow that
     * minted this row does not use one — the legacy account-connect flow, for
     * example. The admin-OIDC flow writes it and reads it back during the
     * callback to bind the id_token to the start request.
     */
    nonce: text("nonce"),

    provider: providerId("provider").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),

    redirectUri: text("redirect_uri"),

    /** Set on first use. A second presentation of a consumed state is rejected. */
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_states_state_key").on(table.state),
    index("oauth_states_expires_at_idx").on(table.expiresAt),
  ],
)

export type OauthStateRow = typeof oauthStates.$inferSelect
export type NewOauthStateRow = typeof oauthStates.$inferInsert
