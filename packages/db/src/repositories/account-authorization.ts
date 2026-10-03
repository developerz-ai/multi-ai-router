import { and, eq, isNull, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accounts } from "../schema/accounts"
import { oauthStates } from "../schema/oauth-states"
import type { AccountAuthorizationMethods } from "./account-lifecycle-types"
import { publishAccountRecovery } from "./account-recovery-generation"

export function createAccountAuthorization(
  db: DatabaseExecutor,
  recoveryCooldownMs = 30_000,
): AccountAuthorizationMethods {
  return {
    beginAccountAuthorization: ({ id, expectedProvider, attempt, now }) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update")
        if (before === undefined || before.provider !== expectedProvider) return undefined
        await tx
          .update(oauthStates)
          .set({ consumedAt: now })
          .where(and(eq(oauthStates.accountId, id), isNull(oauthStates.consumedAt)))
        const [pending] = await tx
          .insert(oauthStates)
          .values({
            ...attempt,
            provider: expectedProvider,
            accountId: id,
            authorizationLifecycleVersion: before.lifecycleVersion,
          })
          .returning()
        const [account] = await tx
          .update(accounts)
          .set({ authorizationAttemptId: attempt.id, updatedAt: now })
          .where(eq(accounts.id, id))
          .returning()
        if (account === undefined || pending === undefined)
          throw new Error("beginAccountAuthorization: missing committed row")
        return { account, pending }
      }),
    cancelAccountAuthorization: ({ id, now }) =>
      db.transaction(async (tx) => {
        const [before] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update")
        if (before === undefined) return undefined
        const abandoned = await tx
          .update(oauthStates)
          .set({ consumedAt: now })
          .where(and(eq(oauthStates.accountId, id), isNull(oauthStates.consumedAt)))
          .returning({ id: oauthStates.id })
        const [account] = await tx
          .update(accounts)
          .set({ authorizationAttemptId: null, updatedAt: now })
          .where(eq(accounts.id, id))
          .returning()
        if (account === undefined)
          throw new Error("cancelAccountAuthorization: locked row disappeared")
        return {
          account,
          cancelled: before.authorizationAttemptId !== null || abandoned.length > 0,
        }
      }),
    commitAuthorization: async ({
      id,
      expectedLifecycleVersion,
      attemptId,
      authMaterial,
      tokenExpiresAt,
      now,
    }) =>
      db.transaction(async (tx) => {
        const rows = await tx
          .update(accounts)
          .set({
            authMaterial,
            tokenExpiresAt,
            updatedAt: now,
            lifecycleVersion: sql`${accounts.lifecycleVersion} + 1`,
            authRecoveryVersion: sql`${accounts.authRecoveryVersion} + 1`,
            authorizationAttemptId: null,
            status: sql`case when ${accounts.status} = 'needs_reauth' then 'active'::account_status else ${accounts.status} end`,
          })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.lifecycleVersion, expectedLifecycleVersion),
              eq(accounts.authorizationAttemptId, attemptId),
            ),
          )
          .returning()
        const account = rows[0]
        if (account !== undefined)
          await publishAccountRecovery(tx, account, recoveryCooldownMs, "authentication-recovered")
        return account
      }),
  }
}
