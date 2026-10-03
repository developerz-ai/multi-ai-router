import { and, eq, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import {
  credentialFingerprint,
  duration,
  lockAccount,
  lockRecovery,
  recoveryClock,
} from "./account-recovery-common"
import type { RecoveryRepository } from "./account-recovery-types"
export function createRecoveryPermits(
  db: DatabaseExecutor,
): Pick<RecoveryRepository, "assignPending" | "issue"> {
  return {
    assignPending: (input) => {
      duration(input.leaseMs)
      return db.transaction(async (tx) => {
        if ((await lockAccount(tx, input.accountId)) === undefined) return undefined
        const held = await lockRecovery(tx, input.accountId)
        if (
          held === undefined ||
          held.state !== "pending" ||
          held.generation !== input.generation ||
          held.ownershipEpoch !== input.expectedEpoch
        )
          return undefined
        const now = await recoveryClock(tx)
        if (
          held.ownerBootId !== null &&
          held.ownerBootId !== input.ownerBootId &&
          held.preparationLeaseUntil !== null &&
          held.preparationLeaseUntil > now
        )
          return undefined
        const [row] = await tx
          .update(accountRecoveries)
          .set({
            ownerBootId: input.ownerBootId,
            ownershipEpoch: sql`${accountRecoveries.ownershipEpoch}+1`,
            revision: sql`${accountRecoveries.revision}+1`,
            preparationLeaseUntil: new Date(now.getTime() + input.leaseMs),
          })
          .where(eq(accountRecoveries.accountId, input.accountId))
          .returning()
        return row
      })
    },
    issue: (input) =>
      db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (
          account === undefined ||
          account.lifecycleVersion !== input.expected.lifecycleVersion ||
          account.authMaterial !== input.expected.authMaterial ||
          account.status !== input.expected.status ||
          account.status === "disabled" ||
          account.status === "exhausted" ||
          account.status === "needs_reauth"
        )
          return undefined
        const held = await lockRecovery(tx, input.accountId)
        if (
          held === undefined ||
          held.generation !== input.generation ||
          held.ownerBootId !== input.ownerBootId ||
          held.ownershipEpoch !== input.expectedEpoch ||
          held.lifecycleVersion !== account.lifecycleVersion ||
          held.credentialFingerprint !== credentialFingerprint(account.authMaterial)
        )
          return undefined
        // Lost issue acknowledgment is hydrated idempotently only by the same live boot and permit.
        if (held.state === "issued") return held.permitId === input.permitId ? held : undefined
        if (held.state !== "pending") return undefined
        const now = await recoveryClock(tx)
        if (held.preparationLeaseUntil === null || held.preparationLeaseUntil <= now)
          return undefined
        const [row] = await tx
          .update(accountRecoveries)
          .set({
            state: "issued",
            permitId: input.permitId,
            issuedAt: now,
            revision: sql`${accountRecoveries.revision}+1`,
          })
          .where(
            and(
              eq(accountRecoveries.accountId, input.accountId),
              eq(accountRecoveries.state, "pending"),
            ),
          )
          .returning()
        return row
      }),
  }
}
