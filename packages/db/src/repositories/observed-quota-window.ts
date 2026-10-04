import { and, eq } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { type AccountRow, accounts } from "../schema/accounts"
import type { AccountRepository } from "./account-types"
import { createQuotaWindowMutations } from "./quota-window-mutations"

export type AccountQuotaObservation = Pick<
  AccountRow,
  "lifecycleVersion" | "healthRecoveryVersion" | "authRecoveryVersion" | "authMaterial" | "status"
> & { readonly recoveryGeneration: string | null }

/** Account-first locking serializes with every recovery publication, including same-L generations. */
export function createObservedQuotaWindowMutation(
  db: DatabaseExecutor,
): Pick<AccountRepository, "upsertObservedQuotaWindow"> {
  return {
    upsertObservedQuotaWindow: async ({ accountId, state, expected }) =>
      db.transaction(async (tx) => {
        const [account] = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for("update")
        if (
          account === undefined ||
          account.lifecycleVersion !== expected.lifecycleVersion ||
          account.healthRecoveryVersion !== expected.healthRecoveryVersion ||
          account.authRecoveryVersion !== expected.authRecoveryVersion ||
          account.authMaterial !== expected.authMaterial ||
          account.status !== expected.status
        )
          return undefined
        // A separate statement after acquiring the account lock obtains the committed generation.
        const [recovery] = await tx
          .select({ generation: accountRecoveries.generation })
          .from(accountRecoveries)
          .where(and(eq(accountRecoveries.accountId, accountId)))
        if ((recovery?.generation ?? null) !== expected.recoveryGeneration) return undefined
        return createQuotaWindowMutations(tx).upsertQuotaWindow(accountId, state)
      }),
  }
}
