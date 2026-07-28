import type { ModelContextSource } from "@multi-ai-router/core"
import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { accounts } from "./accounts"

/**
 * What each Account's upstream says it serves, and how big those models are.
 *
 * **This table does not decide routing, and that is the whole point.** `accounts.supported_models`
 * gates which Accounts a request may land on, and it is deliberately operator-owned: a catalog that
 * refreshed itself on a timer would change routing without anyone asking, so an upstream retiring a
 * model would quietly drop an Account out of selection mid-deployment. That decision stands. This
 * table is the *other* half — a description, refreshed hourly, that nothing in selection reads. It
 * answers "what can this router reach, and how much fits" for a client, a console, and the public
 * catalog listing, without any of them being able to move traffic.
 *
 * Keyed by **account**, not by provider, because two Accounts of one provider genuinely differ:
 * a `zai` key on a coding plan and one on the metered API answer the same listing endpoint
 * differently, and an `openai-compatible` Account's whole catalog is whatever base URL the operator
 * pointed it at. Collapsing to one row per provider would make five Claude subscriptions share one
 * answer, which is the assumption this product exists to avoid.
 *
 * Rows are replaced wholesale per Account rather than merged: a model the upstream stopped listing
 * has to *leave*, and an upsert-only refresh would accumulate models nobody serves until the table
 * described a router that no longer existed.
 */
export const modelCatalog = pgTable(
  "model_catalog",
  {
    accountId: uuid("account_id")
      .notNull()
      // The catalog is a description of an Account. Delete the Account and the description is not
      // stale, it is meaningless.
      .references(() => accounts.id, { onDelete: "cascade" }),

    /** Upstream-side id, exactly as the provider named it — the side `model_aliases` points *at*. */
    modelId: text("model_id").notNull(),

    /**
     * Total context window in tokens, or NULL for **unknown**.
     *
     * Never zero for unknown, and never a default: a client reading a missing window as unlimited
     * builds a request the upstream rejects, so the absence must survive to the wire as `null`.
     */
    contextTokens: integer("context_tokens"),

    /** Largest completion the model will produce, in tokens. NULL where nothing published one. */
    maxOutputTokens: integer("max_output_tokens"),

    /**
     * `upstream` | `shipped` — where the two numbers above came from. `text` rather than a Postgres
     * enum by the rule in `enums.ts`: this only *labels* a reading, so learning a new source should
     * be a core-only change rather than a migration.
     *
     * NULL exactly when both numbers are NULL. A provenance for nothing is noise.
     */
    contextSource: text("context_source").$type<ModelContextSource>(),

    /**
     * When the refresh that wrote this row ran. Rendered beside the catalog, because a listing with
     * no timestamp cannot be told apart from a listing that has quietly stopped refreshing.
     */
    refreshedAt: timestamp("refreshed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One row per (account, model): re-listing a model updates it, never duplicates it.
    primaryKey({ columns: [table.accountId, table.modelId] }),
    // The catalog listing's only query groups every row by model id across accounts.
    index("model_catalog_model_id_idx").on(table.modelId),
  ],
)

export type ModelCatalogRow = typeof modelCatalog.$inferSelect
export type NewModelCatalogRow = typeof modelCatalog.$inferInsert
