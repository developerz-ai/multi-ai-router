import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { type AccountRow, accounts } from "../schema/accounts"
import type { AccountObservation } from "./account-lifecycle-types"

export interface BackgroundAccountSubject
  extends Pick<AccountObservation, "lifecycleVersion" | "authMaterial"> {
  readonly provider: AccountRow["provider"]
  readonly configDir: string | null
}
function eligible() {
  return and(
    eq(accounts.status, "active"),
    sql`not exists (select 1 from ${accountRecoveries} where ${accountRecoveries.accountId} = ${accounts.id} and ${accountRecoveries.state} in ('pending', 'issued', 'uncertain'))`,
  )
}
/** These reads are background-only; no transaction remains open through a provider call. */
export function createBackgroundAccountEligibility(db: DatabaseExecutor) {
  return {
    readEligibleBackgroundAccount: async (
      id: string,
      expected: BackgroundAccountSubject,
    ): Promise<AccountRow | undefined> => {
      const [row] = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, id),
            eligible(),
            eq(accounts.lifecycleVersion, expected.lifecycleVersion),
            eq(accounts.provider, expected.provider),
            sql`${accounts.authMaterial} is not distinct from ${expected.authMaterial}`,
            sql`${accounts.configDir} is not distinct from ${expected.configDir}`,
          ),
        )
      return row
    },
    findIdle: async ({ before, limit }: { before: Date; limit: number }): Promise<AccountRow[]> => {
      if (!Number.isSafeInteger(limit) || limit < 1) return []
      return db
        .select()
        .from(accounts)
        .where(and(eligible(), or(isNull(accounts.lastUsedAt), lt(accounts.lastUsedAt, before))))
        .orderBy(sql`${accounts.lastUsedAt} asc nulls first`, asc(accounts.id))
        .limit(limit)
    },
  }
}
