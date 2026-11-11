import { asc, eq, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import {
  type AccountExhaustedWatchRow,
  accountExhaustedWatches,
} from "../schema/account-exhausted-watches"
import { accounts } from "../schema/accounts"

/**
 * The persisted `exhausted` re-test ladder (rule 7). Repositories own SQL; this file is the only
 * place that knows `account_exhausted_watches` is a table.
 *
 * Read once per `cooldown_recheck` tick and written back per account the tick stepped. Only the
 * replica holding the task's advisory lock writes, so last-writer-wins is the right semantics and
 * no compare-and-set is needed.
 */
export interface ExhaustedWatchRepository {
  /** Every watch, by account id. Bounded by the account count. */
  list(): Promise<ExhaustedWatchRow[]>
  /**
   * Creates or replaces one account's watch. A watch for an account deleted in the meantime is
   * silently not written (the row would only be cascaded away). Returns whether it was written.
   */
  save(accountId: string, watch: ExhaustedWatchState): Promise<boolean>
  /** Ends one account's watch. Returns whether there was one. */
  remove(accountId: string): Promise<boolean>
}

export type ExhaustedWatchRow = Pick<
  AccountExhaustedWatchRow,
  "accountId" | "retests" | "dueAt" | "lastRetestAt"
>

export interface ExhaustedWatchState {
  readonly retests: number
  readonly dueAt: Date
  readonly lastRetestAt: Date | null
}

export function createExhaustedWatchRepository(db: DatabaseExecutor): ExhaustedWatchRepository {
  const columns = {
    accountId: accountExhaustedWatches.accountId,
    retests: accountExhaustedWatches.retests,
    dueAt: accountExhaustedWatches.dueAt,
    lastRetestAt: accountExhaustedWatches.lastRetestAt,
  }
  return {
    list: () =>
      db
        .select(columns)
        .from(accountExhaustedWatches)
        .orderBy(asc(accountExhaustedWatches.accountId)),

    // `insert … select from accounts` rather than `values`: an account deleted between the tick's
    // read and this write yields no row instead of a foreign-key error that fails the tick.
    save: async (accountId, watch) => {
      const rows = await db
        .insert(accountExhaustedWatches)
        .select(
          db
            .select({
              accountId: accounts.id,
              retests: sql<number>`${watch.retests}::int`.as("retests"),
              dueAt: sql<Date>`${watch.dueAt.toISOString()}::timestamptz`.as("due_at"),
              lastRetestAt:
                sql<Date | null>`${watch.lastRetestAt?.toISOString() ?? null}::timestamptz`.as(
                  "last_retest_at",
                ),
              updatedAt: sql<Date>`now()`.as("updated_at"),
            })
            .from(accounts)
            .where(eq(accounts.id, accountId)),
        )
        .onConflictDoUpdate({
          target: accountExhaustedWatches.accountId,
          set: {
            retests: sql`excluded.retests`,
            dueAt: sql`excluded.due_at`,
            lastRetestAt: sql`excluded.last_retest_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ accountId: accountExhaustedWatches.accountId })
      return rows.length > 0
    },

    remove: async (accountId) => {
      const rows = await db
        .delete(accountExhaustedWatches)
        .where(eq(accountExhaustedWatches.accountId, accountId))
        .returning({ accountId: accountExhaustedWatches.accountId })
      return rows.length > 0
    },
  }
}
