import type { AccountStatus } from "@multi-ai-router/core"
import { and, eq, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { accounts } from "../schema/accounts"
import type { AccountLifecycleMethods, AccountObservation } from "./account-lifecycle-types"
import { duration } from "./account-recovery-common"
import { publishAccountRecovery } from "./account-recovery-generation"

function observedGeneration(id: string, expected: string | null | undefined) {
  if (expected === undefined) return undefined
  return expected === null
    ? sql`not exists (select 1 from ${accountRecoveries} where ${accountRecoveries.accountId} = ${id})`
    : sql`exists (select 1 from ${accountRecoveries} where ${accountRecoveries.accountId} = ${id} and ${accountRecoveries.generation} = ${expected})`
}
export function observedAccount(id: string, expected: AccountObservation) {
  return and(
    eq(accounts.id, id),
    eq(accounts.lifecycleVersion, expected.lifecycleVersion),
    sql`${accounts.authMaterial} is not distinct from ${expected.authMaterial}`,
    eq(accounts.status, expected.status),
    observedGeneration(id, expected.recoveryGeneration),
  )
}

export function createAccountLifecycle(
  db: DatabaseExecutor,
  recoveryCooldownMs = 30_000,
): AccountLifecycleMethods {
  duration(recoveryCooldownMs)
  const completeAuthorization = async (
    id: string,
    expected: Pick<AccountObservation, "lifecycleVersion" | "authMaterial">,
    now: Date,
    observedStatus?: AccountStatus,
    recoveryGeneration?: string | null,
  ) =>
    db.transaction(async (tx) => {
      if (recoveryGeneration !== undefined)
        await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id)).for("update")
      const rows = await tx
        .update(accounts)
        .set({
          lifecycleVersion: sql`${accounts.lifecycleVersion} + 1`,
          authRecoveryVersion: sql`${accounts.authRecoveryVersion} + 1`,
          status: sql`case when ${accounts.status} = 'needs_reauth' then 'active'::account_status else ${accounts.status} end`,
          updatedAt: now,
        })
        .where(
          and(
            eq(accounts.id, id),
            eq(accounts.lifecycleVersion, expected.lifecycleVersion),
            sql`${accounts.authMaterial} is not distinct from ${expected.authMaterial}`,
            ...(observedStatus === undefined ? [] : [eq(accounts.status, observedStatus)]),
            observedGeneration(id, recoveryGeneration),
          ),
        )
        .returning()
      const account = rows[0]
      if (account !== undefined)
        await publishAccountRecovery(tx, account, recoveryCooldownMs, "authentication-recovered")
      return account
    })
  return {
    saveRefreshedCredential: async ({
      id,
      expectedAuthMaterial,
      authMaterial,
      tokenExpiresAt,
      now,
    }) => {
      const rows = await db
        .update(accounts)
        .set({ authMaterial, tokenExpiresAt, updatedAt: now })
        .where(and(eq(accounts.id, id), eq(accounts.authMaterial, expectedAuthMaterial)))
        .returning()
      return rows[0]
    },
    transitionObservedStatus: async ({ id, expected, status, now }) => {
      if (status === expected.status) return undefined
      const mutate = async (executor: DatabaseExecutor) => {
        if (expected.recoveryGeneration !== undefined)
          await executor
            .select({ id: accounts.id })
            .from(accounts)
            .where(eq(accounts.id, id))
            .for("update")
        const rows = await executor
          .update(accounts)
          .set({ status, updatedAt: now })
          .where(observedAccount(id, expected))
          .returning()
        return rows[0]
      }
      return expected.recoveryGeneration === undefined ? mutate(db) : db.transaction(mutate)
    },
    updateOperatorAccount: async ({ id, patch, now }) => {
      const credential = patch.authMaterial !== undefined
      const intent = credential || patch.status !== undefined
      const mutate = async (executor: DatabaseExecutor) => {
        const rows = await executor
          .update(accounts)
          .set({
            ...patch,
            updatedAt: now,
            ...(credential
              ? {
                  tokenExpiresAt: patch.tokenExpiresAt ?? null,
                  authRecoveryVersion: sql`${accounts.authRecoveryVersion} + 1`,
                }
              : {}),
            ...(intent
              ? {
                  lifecycleVersion: sql`${accounts.lifecycleVersion} + 1`,
                  authorizationAttemptId: null,
                }
              : {}),
            ...(patch.status === "active"
              ? { healthRecoveryVersion: sql`${accounts.healthRecoveryVersion} + 1` }
              : {}),
          })
          .where(eq(accounts.id, id))
          .returning()
        const account = rows[0]
        if (account !== undefined && (credential || patch.status === "active"))
          await publishAccountRecovery(
            executor,
            account,
            recoveryCooldownMs,
            credential ? "authentication-recovered" : "operator-enable",
          )
        return account
      }
      return credential || patch.status === "active" ? db.transaction(mutate) : mutate(db)
    },
    recheckAccount: ({ id, now }) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update")
        if (before === undefined) return undefined
        const [account] = await tx
          .update(accounts)
          .set({
            lifecycleVersion: sql`${accounts.lifecycleVersion} + 1`,
            healthRecoveryVersion: sql`${accounts.healthRecoveryVersion} + 1`,
            status: before.status === "exhausted" ? "active" : before.status,
            updatedAt: now,
          })
          .where(eq(accounts.id, id))
          .returning()
        if (account === undefined) throw new Error("recheckAccount: locked row disappeared")
        return {
          account,
          clearedStatus: before.status === "exhausted" ? ("exhausted" as const) : null,
        }
      }),
    recoverObservedAuthentication: (input) => {
      if (input.expected.status !== "needs_reauth") return Promise.resolve(undefined)
      return completeAuthorization(
        input.id,
        input.expected,
        input.now,
        "needs_reauth",
        input.expected.recoveryGeneration,
      )
    },
    confirmAccountAuthorization: ({ id, expected, now }) =>
      completeAuthorization(id, expected, now),
  }
}
