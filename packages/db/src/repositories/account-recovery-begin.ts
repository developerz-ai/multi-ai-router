import { eq, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { accounts } from "../schema/accounts"
import type { AccountObservation } from "./account-lifecycle-types"
import {
  credentialFingerprint,
  duration,
  lockAccount,
  lockRecovery,
  recoveryClock,
} from "./account-recovery-common"
import { replaceGeneration } from "./account-recovery-generation"
import type { RecoveryRepository } from "./account-recovery-types"

function matches(account: AccountObservation, expected: AccountObservation): boolean {
  return (
    account.lifecycleVersion === expected.lifecycleVersion &&
    account.authMaterial === expected.authMaterial &&
    account.status === expected.status
  )
}
export function createRecoveryBegin(
  db: DatabaseExecutor,
): Pick<RecoveryRepository, "beginOperatorRecovery" | "beginAutomaticRecovery"> {
  return {
    beginOperatorRecovery: (input) => {
      duration(input.cooldownMs)
      return db.transaction(async (tx) => {
        const before = await lockAccount(tx, input.accountId)
        if (before === undefined) return undefined
        const held = await lockRecovery(tx, input.accountId)
        const now = await recoveryClock(tx)
        if (held !== undefined && held.generation === input.generationCandidate)
          return { account: before, recovery: held, rechecked: false, clearedStatus: null }
        if (held !== undefined && held.nextAllowedAt > now)
          return { account: before, recovery: held, rechecked: false, clearedStatus: null }
        const negative = input.negativeAuthObservation
        const knownLoggedOut =
          negative !== undefined &&
          negative.loggedIn === false &&
          negative.lifecycleVersion === before.lifecycleVersion &&
          negative.authMaterial === before.authMaterial
        const clearedStatus =
          before.status === "exhausted" && !knownLoggedOut ? ("exhausted" as const) : null
        const [account] = await tx
          .update(accounts)
          .set({
            lifecycleVersion: sql`${accounts.lifecycleVersion}+1`,
            healthRecoveryVersion: sql`${accounts.healthRecoveryVersion}+1`,
            status: clearedStatus === "exhausted" ? "active" : before.status,
            updatedAt: now,
          })
          .where(eq(accounts.id, input.accountId))
          .returning()
        if (account === undefined) throw new Error("operator recovery lost locked account")
        const recovery = await replaceGeneration(
          tx,
          {
            ...input,
            lifecycleVersion: account.lifecycleVersion,
            authMaterial: account.authMaterial,
            reason: "operator-recheck",
            ineligible:
              knownLoggedOut ||
              account.status === "disabled" ||
              account.status === "exhausted" ||
              account.status === "needs_reauth",
          },
          held,
          now,
        )
        return { account, recovery, rechecked: true, clearedStatus }
      })
    },
    beginAutomaticRecovery: (input) => {
      duration(input.cooldownMs)
      duration(input.maximumOutcomeAgeMs)
      return db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (account === undefined) return undefined
        const held = await lockRecovery(tx, input.accountId)
        if (
          held !== undefined &&
          (held.state === "pending" || held.state === "issued") &&
          (held.lifecycleVersion !== account.lifecycleVersion ||
            held.credentialFingerprint !== credentialFingerprint(account.authMaterial))
        ) {
          const now = await recoveryClock(tx)
          await tx
            .update(accountRecoveries)
            .set({
              state: held.state === "pending" ? "cancelled" : "uncertain",
              outcomeAt: now,
              revision: sql`${accountRecoveries.revision} + 1`,
              // A fenced issued permit may still have its call on the wire, so its successor waits
              // out the same bound that declares an unacknowledged permit uncertain.
              ...(held.state === "issued" && held.issuedAt !== null
                ? {
                    nextAllowedAt: latest(
                      held.nextAllowedAt,
                      new Date(held.issuedAt.getTime() + input.maximumOutcomeAgeMs),
                    ),
                  }
                : {}),
            })
            .where(eq(accountRecoveries.accountId, input.accountId))
          return undefined
        }
        if (
          !matches(account, input.expected) ||
          account.status === "disabled" ||
          account.status === "exhausted" ||
          account.status === "needs_reauth"
        )
          return undefined
        if (
          held !== undefined &&
          (held.state === "pending" || held.state === "issued") &&
          held.lifecycleVersion === account.lifecycleVersion &&
          held.credentialFingerprint === credentialFingerprint(account.authMaterial)
        )
          return held
        if ((held?.revision ?? null) !== input.expectedRecoveryRevision) return undefined
        const now = await recoveryClock(tx)
        // `uncertain` is bounded like `failed`: its `nextAllowedAt` already covers the outcome bound
        // (`markUncertain` fires only past it; the fence above extends it), and an owner-recorded
        // `uncertain` attempt has settled. Terminal-until-an-operator blocked routing indefinitely.
        if (
          held !== undefined &&
          (held.generation === input.generationCandidate || held.nextAllowedAt > now)
        )
          return undefined
        // Only fresh captured recovery revision can start the next automatic generation.
        return replaceGeneration(
          tx,
          {
            ...input,
            lifecycleVersion: account.lifecycleVersion,
            authMaterial: account.authMaterial,
          },
          held,
          now,
        )
      })
    },
  }
}

function latest(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}
