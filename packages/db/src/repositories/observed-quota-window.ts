import { and, asc, eq, inArray } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { type AccountRow, accounts } from "../schema/accounts"
import type { AccountRepository } from "./account-types"
import {
  createQuotaWindowMutations,
  type QuotaWindowWrite,
  upsertQuotaWindowBatch,
} from "./quota-window-mutations"

export type AccountQuotaObservation = Pick<
  AccountRow,
  "lifecycleVersion" | "healthRecoveryVersion" | "authRecoveryVersion" | "authMaterial" | "status"
> & { readonly recoveryGeneration: string | null }

export interface ObservedQuotaWindowWrite extends QuotaWindowWrite {
  readonly expected: AccountQuotaObservation
}

type FenceRow = Pick<AccountRow, keyof Omit<AccountQuotaObservation, "recoveryGeneration">>

function fenceHolds(
  account: FenceRow | undefined,
  generation: string | null,
  expected: AccountQuotaObservation,
): boolean {
  return (
    account !== undefined &&
    account.lifecycleVersion === expected.lifecycleVersion &&
    account.healthRecoveryVersion === expected.healthRecoveryVersion &&
    account.authRecoveryVersion === expected.authRecoveryVersion &&
    account.authMaterial === expected.authMaterial &&
    account.status === expected.status &&
    generation === expected.recoveryGeneration
  )
}

/** Account-first locking serializes with every recovery publication, including same-L generations. */
export function createObservedQuotaWindowMutation(
  db: DatabaseExecutor,
): Pick<AccountRepository, "upsertObservedQuotaWindow" | "upsertObservedQuotaWindows"> {
  return {
    upsertObservedQuotaWindow: async ({ accountId, state, expected }) =>
      db.transaction(async (tx) => {
        const [account] = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for("update")
        // A separate statement after acquiring the account lock obtains the committed generation.
        const [recovery] = await tx
          .select({ generation: accountRecoveries.generation })
          .from(accountRecoveries)
          .where(and(eq(accountRecoveries.accountId, accountId)))
        if (!fenceHolds(account, recovery?.generation ?? null, expected)) return undefined
        return createQuotaWindowMutations(tx).upsertQuotaWindow(accountId, state)
      }),

    // The same fence for a whole flush in three statements: every named account locked at once
    // (id order, so two flushes cannot deadlock), their generations read after the locks, then
    // one upsert of the readings whose observation still holds. A stale reading is skipped, not
    // failed — exactly what the single-row form's `undefined` means.
    upsertObservedQuotaWindows: async (writes) => {
      if (writes.length === 0) return 0
      return db.transaction(async (tx) => {
        const ids = [...new Set(writes.map((write) => write.accountId))]
        const locked = await tx
          .select()
          .from(accounts)
          .where(inArray(accounts.id, ids))
          .orderBy(asc(accounts.id))
          .for("update")
        const recoveries = await tx
          .select({
            accountId: accountRecoveries.accountId,
            generation: accountRecoveries.generation,
          })
          .from(accountRecoveries)
          .where(inArray(accountRecoveries.accountId, ids))
        const byId = new Map(locked.map((row) => [row.id, row]))
        const generations = new Map(recoveries.map((row) => [row.accountId, row.generation]))
        const current = writes.filter((write) =>
          fenceHolds(
            byId.get(write.accountId),
            generations.get(write.accountId) ?? null,
            write.expected,
          ),
        )
        return upsertQuotaWindowBatch(tx, current, new Set(byId.keys()))
      })
    },
  }
}
