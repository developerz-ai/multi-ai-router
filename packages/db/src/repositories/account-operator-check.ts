import { and, eq } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountOperatorChecks } from "../schema/account-operator-checks"
import { createRecoveryBegin } from "./account-recovery-begin"
import { duration, lockAccount, lockRecovery, recoveryClock } from "./account-recovery-common"
import type { RecoveryRepository } from "./account-recovery-types"

export function createOperatorChecks(
  db: DatabaseExecutor,
): Pick<
  RecoveryRepository,
  "reserveOperatorCheck" | "finalizeOperatorCheck" | "releaseOperatorCheck"
> {
  const lockClaim = async (tx: DatabaseExecutor, id: string) => {
    const [claim] = await tx
      .select()
      .from(accountOperatorChecks)
      .where(eq(accountOperatorChecks.accountId, id))
      .for("update")
    return claim
  }
  return {
    reserveOperatorCheck: (input) => {
      duration(input.leaseMs)
      return db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (account === undefined) return undefined
        const recovery = await lockRecovery(tx, input.accountId)
        const claim = await lockClaim(tx, input.accountId)
        const now = await recoveryClock(tx)
        if (recovery !== undefined && recovery.nextAllowedAt > now)
          return { kind: "cooldown" as const, account, recovery, retryAt: recovery.nextAllowedAt }
        if (claim !== undefined && claim.leaseUntil > now)
          return { kind: "busy" as const, account, recovery, retryAt: claim.leaseUntil }
        const leaseUntil = new Date(now.getTime() + input.leaseMs)
        await tx
          .insert(accountOperatorChecks)
          .values({
            accountId: input.accountId,
            claimToken: input.claimToken,
            leaseUntil,
          })
          .onConflictDoUpdate({
            target: accountOperatorChecks.accountId,
            set: { claimToken: input.claimToken, leaseUntil },
          })
        return { kind: "acquired" as const, account, claimToken: input.claimToken, leaseUntil }
      })
    },
    finalizeOperatorCheck: (input) =>
      db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (account === undefined) return undefined
        const recovery = await lockRecovery(tx, input.accountId)
        const claim = await lockClaim(tx, input.accountId)
        const now = await recoveryClock(tx)
        if (claim === undefined || claim.claimToken !== input.claimToken || claim.leaseUntil <= now)
          return {
            kind: "refused" as const,
            checkInProgress: claim !== undefined && claim.leaseUntil > now,
            account,
            recovery,
            retryAt:
              recovery !== undefined && recovery.nextAllowedAt > now
                ? recovery.nextAllowedAt
                : claim !== undefined && claim.leaseUntil > now
                  ? claim.leaseUntil
                  : now,
          }
        // Reuse authoritative begin in a savepoint on this transaction's connection.
        // A positive auth probe may already have published a pending cooldown: join it.
        const result = await createRecoveryBegin(tx).beginOperatorRecovery(input)
        if (result === undefined) throw new Error("operator check lost locked account")
        await tx
          .delete(accountOperatorChecks)
          .where(
            and(
              eq(accountOperatorChecks.accountId, input.accountId),
              eq(accountOperatorChecks.claimToken, input.claimToken),
            ),
          )
        return { kind: "committed" as const, result }
      }),
    releaseOperatorCheck: async ({ accountId, claimToken }) => {
      await db
        .delete(accountOperatorChecks)
        .where(
          and(
            eq(accountOperatorChecks.accountId, accountId),
            eq(accountOperatorChecks.claimToken, claimToken),
          ),
        )
    },
  }
}
