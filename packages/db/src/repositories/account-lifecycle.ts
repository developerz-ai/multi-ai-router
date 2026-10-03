import { and, eq, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accounts } from "../schema/accounts"
import type { AccountLifecycleMethods, AccountObservation } from "./account-lifecycle-types"

export function observedAccount(id: string, expected: AccountObservation) {
  return and(
    eq(accounts.id, id),
    eq(accounts.lifecycleVersion, expected.lifecycleVersion),
    sql`${accounts.authMaterial} is not distinct from ${expected.authMaterial}`,
    eq(accounts.status, expected.status),
  )
}

export function createAccountLifecycle(db: DatabaseExecutor): AccountLifecycleMethods {
  const confirm: AccountLifecycleMethods["confirmAccountAuthorization"] = async ({
    id,
    expected,
    now,
  }) => {
    const rows = await db
      .update(accounts)
      .set({
        lifecycleVersion: sql`${accounts.lifecycleVersion} + 1`,
        authRecoveryVersion: sql`${accounts.authRecoveryVersion} + 1`,
        status: sql`case when ${accounts.status} = 'needs_reauth' then 'active'::account_status else ${accounts.status} end`,
        updatedAt: now,
      })
      .where(observedAccount(id, expected))
      .returning()
    return rows[0]
  }
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
      const rows = await db
        .update(accounts)
        .set({ status, updatedAt: now })
        .where(observedAccount(id, expected))
        .returning()
      return rows[0]
    },
    updateOperatorAccount: async ({ id, patch, now }) => {
      const credential = patch.authMaterial !== undefined
      const intent = credential || patch.status !== undefined
      const rows = await db
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
      return rows[0]
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
      return confirm(input)
    },
    confirmAccountAuthorization: confirm,
  }
}
