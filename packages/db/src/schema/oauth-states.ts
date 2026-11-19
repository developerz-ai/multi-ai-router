import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { accounts } from "./accounts"
import type { AuditActorKind } from "./audit-events"

/**
 * Who started a connect, as the guarded start request's audit context held it
 * (`apps/api/src/services/admin/audit-context.ts`, the same six fields). Stored so the unguarded
 * redirect callback, and a device poll by anyone, record the starter (multi-ai-router#455).
 * Untrusted on the way back out: the service parses it before running under it.
 */
export interface OauthStateInitiator {
  readonly actor: string
  readonly actorKind: AuditActorKind
  readonly says: string | null
  readonly clientIp: string | null
  readonly userAgent: string | null
  readonly requestId: string | null
}

/**
 * One-shot OAuth `state` + PKCE verifier, bound to a pending account row and
 * purged on a short TTL. Server-side only: a mismatched or reused `state` is
 * rejected, which is why the row records when it was consumed rather than being
 * deleted inline.
 *
 * Claude subscription accounts do not use this table — their login is handed to
 * the `claude` CLI and lands in the account's `CLAUDE_CONFIG_DIR`.
 *
 * The `provider` column is `text` rather than the enum used elsewhere on
 * purpose: the admin-plane OIDC flow writes the synthetic value
 * `admin-oidc` to mark rows that do not belong to a real AI provider, and
 * the legacy account-connect flow writes one of the enum members. Postgres
 * enums cannot be widened silently, and a synthetic id in the provider enum
 * would violate the architectural invariant that every declared id has a
 * driver (apps/api/test/unit/providers/registry.test.ts). The legacy flow
 * still uses real provider values; only the column's vocabulary is widened.
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

    /**
     * Free-form identifier of the flow that minted this row. Real
     * AI-provider values (e.g. "openai-oauth") for the legacy
     * account-connect flow; "admin-oidc" for the admin-plane OIDC flow.
     * `text` so the admin synthetic value is not rejected at insert time.
     */
    provider: text("provider").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),

    authorizationLifecycleVersion: integer("authorization_lifecycle_version"),
    redirectUri: text("redirect_uri"),

    /**
     * The caller who started this connect ({@link OauthStateInitiator}). Null on a row minted
     * before migration 0050, on the admin-OIDC sign-in flow, and wherever a start ran with no
     * caller: the completing write then falls back to its own caller, or to `unattributed`.
     */
    initiatedBy: jsonb("initiated_by").$type<OauthStateInitiator>(),

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
