import type { QuotaWindowKind } from "@multi-ai-router/core"
import { and, eq, gte, isNull, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { quotaWindows } from "../schema/quota-windows"
import {
  credentialFingerprint,
  duration,
  lockAccount,
  lockRecovery,
  recoveryClock,
} from "./account-recovery-common"
import type { RecoveryRepository } from "./account-recovery-types"

export function createRecoveryOutcomes(
  db: DatabaseExecutor,
): Pick<RecoveryRepository, "hydrateIssued" | "outcome" | "markUncertain" | "cancel"> {
  return {
    hydrateIssued: (input) => {
      duration(input.maximumOutcomeAgeMs)
      return db.transaction(async (tx) => {
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
          held.state !== "issued" ||
          held.generation !== input.generation ||
          held.permitId !== input.permitId ||
          held.ownerBootId !== input.ownerBootId ||
          held.ownershipEpoch !== input.expectedEpoch ||
          held.lifecycleVersion !== account.lifecycleVersion ||
          held.credentialFingerprint !== credentialFingerprint(account.authMaterial) ||
          held.issuedAt === null
        )
          return undefined
        const now = await recoveryClock(tx)
        return now.getTime() - held.issuedAt.getTime() < input.maximumOutcomeAgeMs
          ? held
          : undefined
      })
    },
    outcome: (input) => {
      duration(input.cooldownMs)
      if (
        !Number.isFinite(input.quotaSpentThreshold) ||
        input.quotaSpentThreshold <= 0 ||
        input.quotaSpentThreshold > 1
      )
        throw new Error("invalid quota spent threshold")
      return db.transaction(async (tx) => {
        const account = await lockAccount(tx, input.accountId)
        if (
          account === undefined ||
          account.lifecycleVersion !== input.expected.lifecycleVersion ||
          account.authMaterial !== input.expected.authMaterial
        )
          return undefined
        const held = await lockRecovery(tx, input.accountId)
        if (
          held === undefined ||
          held.generation !== input.generation ||
          held.permitId !== input.permitId ||
          held.ownerBootId !== input.ownerBootId ||
          held.ownershipEpoch !== input.expectedEpoch ||
          held.lifecycleVersion !== account.lifecycleVersion ||
          held.credentialFingerprint !== credentialFingerprint(account.authMaterial)
        )
          return undefined
        if (held.state === input.state) return held // Idempotent response-loss retry, no repeated quota retirement.
        if (held.state !== "issued") return undefined
        const now = await recoveryClock(tx)
        const [row] = await tx
          .update(accountRecoveries)
          .set({
            state: input.state,
            outcomeAt: now,
            revision: sql`${accountRecoveries.revision}+1`,
            nextAllowedAt: new Date(now.getTime() + input.cooldownMs),
          })
          .where(eq(accountRecoveries.accountId, input.accountId))
          .returning()
        if (row === undefined) throw new Error("outcome lost locked recovery")
        if (
          input.state === "succeeded" &&
          (account.status === "active" || account.status === "cooling_down")
        ) {
          for (const [window, revision] of Object.entries(held.quotaRevisions)) {
            await tx
              .update(quotaWindows)
              .set({
                evidenceState: "superseded_by_recovery",
                blocksRouting: false,
                retiredAt: now,
                revision: sql`${quotaWindows.revision}+1`,
              })
              .where(
                and(
                  eq(quotaWindows.accountId, input.accountId),
                  eq(quotaWindows.window, window as QuotaWindowKind),
                  eq(quotaWindows.revision, revision),
                  isNull(quotaWindows.retiredAt),
                  eq(quotaWindows.evidenceState, "current"),
                  gte(quotaWindows.utilization, input.quotaSpentThreshold),
                ),
              )
          }
        }
        return row
      })
    },
    markUncertain: (input) => {
      duration(input.maximumOutcomeAgeMs)
      return db.transaction(async (tx) => {
        if ((await lockAccount(tx, input.accountId)) === undefined) return undefined
        const held = await lockRecovery(tx, input.accountId)
        if (
          held === undefined ||
          held.state !== "issued" ||
          held.generation !== input.generation ||
          held.permitId !== input.permitId ||
          held.issuedAt === null
        )
          return undefined
        const now = await recoveryClock(tx)
        if (now.getTime() - held.issuedAt.getTime() < input.maximumOutcomeAgeMs) return undefined
        const [row] = await tx
          .update(accountRecoveries)
          .set({
            state: "uncertain",
            outcomeAt: now,
            revision: sql`${accountRecoveries.revision}+1`,
          })
          .where(eq(accountRecoveries.accountId, input.accountId))
          .returning()
        return row
      })
    },
    cancel: (input) =>
      db.transaction(async (tx) => {
        if ((await lockAccount(tx, input.accountId)) === undefined) return undefined
        const held = await lockRecovery(tx, input.accountId)
        if (
          held === undefined ||
          held.generation !== input.generation ||
          (held.state !== "pending" && held.state !== "issued")
        )
          return undefined
        const now = await recoveryClock(tx)
        const [row] = await tx
          .update(accountRecoveries)
          .set({
            state: "cancelled",
            outcomeAt: now,
            revision: sql`${accountRecoveries.revision}+1`,
          })
          .where(eq(accountRecoveries.accountId, input.accountId))
          .returning()
        return row
      }),
  }
}
