import type { ProviderId } from "@multi-ai-router/core"
import { asc } from "drizzle-orm"
import type { Database } from "../client"
import { type PriceOverrideRow, priceOverrides } from "../schema/price-overrides"

/**
 * Repositories own SQL. This file is the only place that knows `price_overrides`
 * is a table.
 *
 * There is no `create`/`update`/`delete` trio, deliberately. The price table is
 * edited as one object on one screen — the same reason pool membership is
 * replaced rather than patched row by row (`pool-repository.ts`): a set applied
 * statement by statement is briefly half-applied, and half a price table is a
 * report priced against rates nobody ever chose. Empty input clears the table and
 * every attempt prices from the shipped fallback again.
 *
 * `model` is expected already normalized (trimmed, lowercased) — the unique index
 * on `(provider, model)` makes that a rule, and the warm price book normalizes the
 * name it looks up the same way.
 */
export interface PriceOverrideRepository {
  /** Provider then model, so the admin screen renders the same order every time. */
  list(): Promise<PriceOverrideRow[]>
  /**
   * The whole table, replaced in one transaction. Returns the new set, ordered as
   * {@link PriceOverrideRepository.list} orders it.
   */
  replaceAll(rows: readonly PriceOverrideInput[], now: Date): Promise<PriceOverrideRow[]>
}

/** US dollars per million tokens, the same unit the shipped price table states. */
export interface PriceOverrideInput {
  readonly provider: ProviderId
  /** Already normalized by the caller: trimmed and lowercased. */
  readonly model: string
  readonly inputPerMtok: number
  readonly outputPerMtok: number
  readonly cacheReadPerMtok: number
  readonly cacheWritePerMtok: number
}

export type { PriceOverrideRow }

export function createPriceOverrideRepository(db: Database): PriceOverrideRepository {
  // Provider sorts in the enum's declared order rather than alphabetically —
  // Postgres orders an enum by its definition. Deterministic either way, which is
  // the property the screen needs.
  const order = [asc(priceOverrides.provider), asc(priceOverrides.model)] as const

  return {
    list: () =>
      db
        .select()
        .from(priceOverrides)
        .orderBy(...order),

    replaceAll: (rows, now) =>
      db.transaction(async (tx) => {
        await tx.delete(priceOverrides)
        if (rows.length === 0) return []
        await tx.insert(priceOverrides).values(
          rows.map((row) => ({
            provider: row.provider,
            model: row.model,
            inputPerMtok: row.inputPerMtok,
            outputPerMtok: row.outputPerMtok,
            cacheReadPerMtok: row.cacheReadPerMtok,
            cacheWritePerMtok: row.cacheWritePerMtok,
            createdAt: now,
            updatedAt: now,
          })),
        )
        // Re-read rather than sorting what `returning` handed back: one ORDER BY
        // defines the order, and it is the one `list` already uses.
        return tx
          .select()
          .from(priceOverrides)
          .orderBy(...order)
      }),
  }
}
