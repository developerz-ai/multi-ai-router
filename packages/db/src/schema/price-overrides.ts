import { numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { providerId } from "./enums"

/**
 * Operator-editable prices, layered over the table shipped in the image
 * (`services/cost/prices.ts`). An override wins; the shipped numbers stay the
 * fallback rather than being replaced, so a deployment that overrides one model
 * still prices every other one (docs/idea/08-observability.md#cost-estimation).
 *
 * Why a table at all: the shipped rates go stale the moment a provider
 * republishes, and a self-hosted or aggregated endpoint has no published price
 * for us to ship in the first place. Editing a price must not mean rebuilding
 * the image.
 *
 * `model` is stored **already normalized** — trimmed and lowercased by the caller,
 * matching how `lookupRates` normalizes the name it is asked for. The unique index
 * on `(provider, model)` makes that a rule rather than a convention: two casings
 * of one model would otherwise both insert and only one would ever be found.
 *
 * There is no retention sweep for this table. It is configuration, not history:
 * rows leave when an operator removes them, never on a clock.
 */

/**
 * US dollars per million tokens, the unit the shipped table already states.
 *
 * `numeric`, never a float: a price is money, and money that round-trips through
 * binary floating point stops being the number the operator typed. Read back as a
 * JS number (`mode: "number"`) because the whole table is held in memory and
 * multiplied by a token count on the way to a `numeric(14, 6)` column — the
 * precision that has to hold is that column's, and no caller should have to parse
 * a price out of a string first.
 */
const PER_MTOK = { precision: 12, scale: 6, mode: "number" } as const

export const priceOverrides = pgTable(
  "price_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerId("provider").notNull(),
    model: text("model").notNull(),

    inputPerMtok: numeric("input_per_mtok", PER_MTOK).notNull(),
    outputPerMtok: numeric("output_per_mtok", PER_MTOK).notNull(),
    /**
     * Stated outright rather than derived from `inputPerMtok`. The shipped table
     * derives them because Anthropic publishes them as multiples of its input
     * rate; an operator overriding a price may be pricing an upstream that does
     * no such thing.
     */
    cacheReadPerMtok: numeric("cache_read_per_mtok", PER_MTOK).notNull(),
    cacheWritePerMtok: numeric("cache_write_per_mtok", PER_MTOK).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("price_overrides_provider_model_key").on(table.provider, table.model)],
)

export type PriceOverrideRow = typeof priceOverrides.$inferSelect
export type NewPriceOverrideRow = typeof priceOverrides.$inferInsert
