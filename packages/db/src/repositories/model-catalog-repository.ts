import type { ModelContextSource, ModelListingSource, ModelReasoning } from "@multi-ai-router/core"
import { asc, eq, inArray, max, sql } from "drizzle-orm"
import type { Database } from "../client"
import { type ModelCatalogRow, modelCatalog, modelCatalogAttempts } from "../schema/model-catalog"

/**
 * Repositories own SQL. This file is the only place that knows `model_catalog` and
 * `model_catalog_attempts` are tables.
 *
 * One Account's catalog is replaced as a set, never patched row by row, for the same reason the
 * price table is (`price-override-repository.ts`): a listing applied statement by statement is
 * briefly half-applied, and half a catalog is a router that appears to have lost models it still
 * serves. Replacement is also what lets a model *leave* — an upsert-only refresh would accumulate
 * ids the upstream stopped listing until the table described a router that no longer existed.
 */
export interface ModelCatalogRepository {
  /**
   * Replace one Account's catalog. Empty input clears it, which is the honest record of an upstream
   * that now lists nothing — this table describes, it does not gate, so an empty catalog costs an
   * Account no traffic.
   */
  replaceForAccount(
    accountId: string,
    rows: readonly ModelCatalogEntry[],
    refreshedAt: Date,
  ): Promise<void>

  /** Every row, account then model. The catalog listing's one query. */
  list(): Promise<ModelCatalogRow[]>

  /** Just these Accounts' rows, in the same order. Empty input is no query at all. */
  listForAccounts(accountIds: readonly string[]): Promise<ModelCatalogRow[]>

  /**
   * The newest `refreshed_at` per Account. Accounts with no catalog at all are **absent** rather
   * than carrying a null date, because "never refreshed" and "refreshed and found nothing" are
   * different facts and the sweep orders on the difference.
   *
   * An aggregate rather than a read of {@link ModelCatalogRepository.list}: the sweep needs one
   * timestamp per Account and the full table can run to thousands of rows once an aggregator-shaped
   * upstream is in it.
   */
  lastRefreshedAt(): Promise<readonly AccountCatalogAge[]>

  /**
   * The per-account attempt bookkeeping: every account the sweep asked without a write — a
   * failed or skipped refresh — with when it was last asked. An account never asked in vain is
   * **absent** rather than carrying a null date, the same shape as {@link lastRefreshedAt}:
   * "never attempted" and "attempted at T" are different facts and the sweep orders on the
   * difference.
   */
  lastAttemptedAt(): Promise<readonly AccountCatalogAttempt[]>

  /**
   * Record that `accountId` was asked for a refresh at `attemptedAt` and the ask wrote nothing.
   * Monotonic: ticks are independent, so an attempt can arrive after a newer one, and the stored
   * timestamp — the sweep's ordering — must never move backwards.
   */
  recordAttempt(accountId: string, attemptedAt: Date): Promise<void>

  /**
   * Forget an account's attempt row, after the sweep's refresh wrote. Absent-safe: the usual
   * success path has nothing recorded, and clearing nothing is the correct no-op.
   */
  clearAttempt(accountId: string): Promise<void>
}

export interface AccountCatalogAge {
  readonly accountId: string
  readonly refreshedAt: Date
}

export interface AccountCatalogAttempt {
  readonly accountId: string
  readonly attemptedAt: Date
}

export interface ModelCatalogEntry {
  /** Upstream-side id. Already trimmed by the caller; the primary key makes that a rule. */
  readonly modelId: string
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  /** Null exactly when both numbers are null. */
  readonly contextSource: ModelContextSource | null
  /** Which voice listed the row. */
  readonly listingSource: ModelListingSource
  /** What an alias row resolves to; null for a concrete id. */
  readonly resolvedModel: string | null
  /** The listing's word on thinking modes. Absent where it said nothing. */
  readonly reasoning?: ModelReasoning
}

export type { ModelCatalogRow }

export function createModelCatalogRepository(db: Database): ModelCatalogRepository {
  const order = [asc(modelCatalog.accountId), asc(modelCatalog.modelId)] as const

  return {
    replaceForAccount: (accountId, rows, refreshedAt) =>
      db.transaction(async (tx) => {
        await tx.delete(modelCatalog).where(eq(modelCatalog.accountId, accountId))
        if (rows.length === 0) return
        await tx.insert(modelCatalog).values(
          rows.map((row) => ({
            accountId,
            modelId: row.modelId,
            contextTokens: row.contextTokens,
            maxOutputTokens: row.maxOutputTokens,
            contextSource: row.contextSource,
            listingSource: row.listingSource,
            resolvedModel: row.resolvedModel,
            reasoning: row.reasoning ?? null,
            refreshedAt,
          })),
        )
      }),

    list: () =>
      db
        .select()
        .from(modelCatalog)
        .orderBy(...order),

    lastRefreshedAt: () =>
      db
        .select({
          accountId: modelCatalog.accountId,
          refreshedAt: max(modelCatalog.refreshedAt),
        })
        .from(modelCatalog)
        .groupBy(modelCatalog.accountId)
        // `max` over a non-null column within a group is never null, but Drizzle types it nullable
        // because SQL says an aggregate over zero rows is. A GROUP BY emits no empty groups, so the
        // filter is the type's cost, not a code path.
        .then((rows) =>
          rows.flatMap((row) =>
            row.refreshedAt === null
              ? []
              : [{ accountId: row.accountId, refreshedAt: row.refreshedAt }],
          ),
        ),

    lastAttemptedAt: () =>
      db
        .select({
          accountId: modelCatalogAttempts.accountId,
          attemptedAt: modelCatalogAttempts.lastAttemptedAt,
        })
        .from(modelCatalogAttempts)
        .orderBy(asc(modelCatalogAttempts.accountId)),

    recordAttempt: async (accountId, attemptedAt) => {
      await db
        .insert(modelCatalogAttempts)
        .values({ accountId, lastAttemptedAt: attemptedAt })
        .onConflictDoUpdate({
          target: modelCatalogAttempts.accountId,
          // GREATEST, not assignment: ticks are independent, so an attempt can land after a
          // newer one, and this column is the ordering — a late-arriving older attempt must
          // never move the timestamp backwards and push an account to the front of a batch it
          // was just asked in.
          set: {
            lastAttemptedAt: sql`greatest(${modelCatalogAttempts.lastAttemptedAt}, excluded.last_attempted_at)`,
          },
        })
    },

    clearAttempt: async (accountId) => {
      // Absent-safe: deleting a row that is not there is the correct no-op — rows exist only for
      // accounts asked in vain, so the usual success clears nothing.
      await db.delete(modelCatalogAttempts).where(eq(modelCatalogAttempts.accountId, accountId))
    },

    listForAccounts: async (accountIds) => {
      // `inArray` with an empty list is a SQL error in Postgres, and an empty ask has an empty
      // answer anyway — the same guard `usage-read-repository.ts` puts on its VALUES join.
      if (accountIds.length === 0) return []
      return db
        .select()
        .from(modelCatalog)
        .where(inArray(modelCatalog.accountId, [...accountIds]))
        .orderBy(...order)
    },
  }
}
