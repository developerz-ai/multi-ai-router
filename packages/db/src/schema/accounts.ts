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
import { accountStatus, providerId } from "./enums"

/** Client model name -> the name this account's upstream expects (`sonnet` -> `glm-4.7`). */
export type ModelAliasMap = Record<string, string>

/**
 * One credential to one provider. Many accounts per provider is the normal case
 * — five Claude subscriptions side by side is the point of the product — so
 * nothing here may key on `provider` alone. `label` is the human disambiguator.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    provider: providerId("provider").notNull(),
    status: accountStatus("status").notNull().default("active"),

    /**
     * AES-256-GCM ciphertext of the API key or OAuth token pair. Never returned
     * by any endpoint. NULL for Claude subscription accounts: those hold no
     * router-managed credential at all, only `configDir`.
     */
    authMaterial: text("auth_material"),

    /**
     * Claude subscription accounts only: one isolated `CLAUDE_CONFIG_DIR` per
     * account, on the persistent volume. Its contents are live credential
     * material owned by the Agent SDK, not by us.
     */
    configDir: text("config_dir"),

    /**
     * Refreshable OAuth accounts only (ChatGPT/Codex today). Drives the
     * per-account expiry-driven refresh schedule, which is rebuilt at boot.
     * NULL for API-key accounts and for Claude subscriptions — the SDK owns
     * those tokens and the router never schedules a refresh for them.
     */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: "date" }),

    /** Absent means the client's model name passes through unchanged. */
    modelAliases: jsonb("model_aliases").$type<ModelAliasMap>(),

    /** Bias for the `weighted` policy. */
    weight: integer("weight").notNull().default(100),
    /** Strict order for the `priority-failover` policy; lower is tried first. */
    priority: integer("priority").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("accounts_provider_idx").on(table.provider),
    index("accounts_status_idx").on(table.status),
    // Two accounts sharing a config directory is cross-contamination of two
    // subscriptions, which is exactly what per-account isolation prevents.
    uniqueIndex("accounts_config_dir_key").on(table.configDir),
  ],
)

export type AccountRow = typeof accounts.$inferSelect
export type NewAccountRow = typeof accounts.$inferInsert
