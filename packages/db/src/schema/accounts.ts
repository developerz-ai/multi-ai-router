import {
  DEFAULT_ACCOUNT_BILLING,
  DEFAULT_ACCOUNT_PRIORITY,
  DEFAULT_ACCOUNT_WEIGHT,
  type Dialect,
  type WindowTokenLimits,
} from "@multi-ai-router/core"
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
import { accountBilling, accountStatus, providerId } from "./enums"

/** Client model name -> the name this account's upstream expects (`sonnet` -> `glm-4.7`). */
export type ModelAliasMap = Record<string, string>

/**
 * The model ids an account's upstream accepts, **as the upstream names them** — the same side of
 * the alias map `model_aliases` points *at*. Discovered from the provider's own `/v1/models`, or
 * typed by the operator.
 */
export type SupportedModelList = string[]

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
     * Whether this account is a per-token bill or a flat fee, which decides
     * whether its usage prices as real spend (`metered`) or as an attribution
     * (`notional`). Per account, because the same provider sells both: a z.ai or
     * Kimi coding plan uses the same endpoint and the same key shape as that
     * vendor's metered API, and only the operator knows which was bought.
     *
     * Defaulted from the provider's driver at write time and forced for the
     * providers sold only as a subscription — see
     * `services/accounts/rules.ts`. The column default is the metered case, the
     * one an unstated row means.
     */
    billing: accountBilling("billing").notNull().default(DEFAULT_ACCOUNT_BILLING),

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

    /**
     * When this account last served a request. Written off the request path by the
     * usage recorder's batched drain, never on it (non-negotiable 8).
     *
     * Exists so "has this account gone unused" is one indexed question about the
     * account, rather than a `NOT EXISTS` over `usage_records` — a table retention
     * prunes, which would make "unused for a week" and "no surviving usage row"
     * silently the same question once the retention window is the shorter of the two.
     *
     * NULL means never used, or not since this column existed. The idle probe reads
     * NULL as idle, which is the safe direction: a connected-but-never-used
     * subscription is precisely the one whose refresh token expires unnoticed.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),

    /**
     * Per-account base URL override. NULL means the provider driver's own
     * default (`03-providers.md` has the verified defaults per provider).
     *
     * This is what makes the `openai-compatible` / `anthropic-compatible`
     * escape hatches work at all — those providers have no default endpoint,
     * the operator supplies one.
     */
    baseUrl: text("base_url"),

    /**
     * Per-account surface override, for providers that expose more than one.
     * NULL means the driver's default dialect.
     *
     * z.ai is the motivating case: the same key works against an
     * Anthropic-dialect endpoint and an OpenAI-dialect one, and the account —
     * not the provider — records which was chosen, because the choice selects
     * the endpoint and the header form together.
     */
    dialect: text("dialect").$type<Dialect>(),

    /** Absent means the client's model name passes through unchanged. */
    modelAliases: jsonb("model_aliases").$type<ModelAliasMap>(),

    /**
     * The model ids this account's upstream accepts, upstream-side. NULL (and
     * `[]`) mean *unknown*, and unknown is passthrough, not exclusion: the
     * account serves whatever the client names. A non-empty list is a claim the
     * router will act on — it filters the account out of selection for anything
     * else, and it is what `GET /v1/models` enumerates.
     *
     * Populated by the operator, or by `POST /:id/models/discover`, which reads
     * the provider's own listing. Deliberately not refreshed on a timer: a model
     * catalog that changes under a running deployment would change routing
     * without an operator ever asking for it.
     */
    supportedModels: jsonb("supported_models").$type<SupportedModelList>(),

    /**
     * Operator-set token ceilings per quota window, keyed by `QuotaWindowKind`.
     *
     * **A number the operator chose, never one the provider stated.** Anthropic publishes no
     * numeric limit and its SDK reports a utilization only near a window's edge, so without this
     * the console has nothing to draw for most of every window. A ceiling here lets it show
     * consumption the router measured itself against a figure the operator owns — labelled as
     * configured wherever it is rendered, and read by nothing in routing, because a guess about
     * someone else's accounting must not decide which account serves a request.
     *
     * NULL, or a window absent from the map, means no bar for that window.
     */
    windowTokenLimits: jsonb("window_token_limits").$type<WindowTokenLimits>(),

    /** Bias for the `weighted` policy. */
    weight: integer("weight").notNull().default(DEFAULT_ACCOUNT_WEIGHT),
    /** Strict order for the `priority-failover` policy; lower is tried first. */
    priority: integer("priority").notNull().default(DEFAULT_ACCOUNT_PRIORITY),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("accounts_provider_idx").on(table.provider),
    index("accounts_status_idx").on(table.status),
    // The idle probe's only query orders the whole table by this. Small table, but the
    // index keeps the sweep from degrading as accounts accumulate.
    index("accounts_last_used_at_idx").on(table.lastUsedAt),
    // Two accounts sharing a config directory is cross-contamination of two
    // subscriptions, which is exactly what per-account isolation prevents.
    uniqueIndex("accounts_config_dir_key").on(table.configDir),
  ],
)

export type AccountRow = typeof accounts.$inferSelect
export type NewAccountRow = typeof accounts.$inferInsert
