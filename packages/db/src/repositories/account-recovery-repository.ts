import { and, asc, eq, inArray, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accountRecoveries } from "../schema/account-recoveries"
import { accounts } from "../schema/accounts"
import { createOperatorChecks } from "./account-operator-check"
import { createRecoveryBegin } from "./account-recovery-begin"
import { createRecoveryOutcomes } from "./account-recovery-outcome"
import { createRecoveryPermits } from "./account-recovery-permit"
import type { RecoveryRepository } from "./account-recovery-types"
export function createRecoveryRepository(db: DatabaseExecutor): RecoveryRepository {
  return {
    readOperatorCooldown: async (accountId) => {
      const [row] = await db
        .select({ account: accounts, recovery: accountRecoveries })
        .from(accounts)
        .innerJoin(accountRecoveries, eq(accountRecoveries.accountId, accounts.id))
        .where(
          and(
            eq(accounts.id, accountId),
            sql`${accountRecoveries.nextAllowedAt} > clock_timestamp()`,
          ),
        )
      return row === undefined ? undefined : { ...row, rechecked: false, clearedStatus: null }
    },
    ...createOperatorChecks(db),
    ...createRecoveryBegin(db),
    ...createRecoveryPermits(db),
    ...createRecoveryOutcomes(db),
    listPending: ({ limit, accountIds }) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || accountIds.length === 0)
        return Promise.resolve([])
      return db
        .select()
        .from(accountRecoveries)
        .where(
          and(
            eq(accountRecoveries.state, "pending"),
            inArray(accountRecoveries.accountId, [...accountIds]),
          ),
        )
        .orderBy(asc(accountRecoveries.requestedAt), asc(accountRecoveries.accountId))
        .limit(limit)
    },
    listIssuedForOwner: ({ limit, ownerBootId, accountIds }) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || accountIds.length === 0)
        return Promise.resolve([])
      return db
        .select()
        .from(accountRecoveries)
        .where(
          and(
            eq(accountRecoveries.state, "issued"),
            eq(accountRecoveries.ownerBootId, ownerBootId),
            inArray(accountRecoveries.accountId, [...accountIds]),
          ),
        )
        .orderBy(asc(accountRecoveries.issuedAt), asc(accountRecoveries.accountId))
        .limit(limit)
    },
    listExpiredIssued: ({ limit, maximumOutcomeAgeMs }) => {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isSafeInteger(maximumOutcomeAgeMs) ||
        maximumOutcomeAgeMs < 1
      )
        return Promise.resolve([])
      return db
        .select()
        .from(accountRecoveries)
        .where(
          and(
            eq(accountRecoveries.state, "issued"),
            sql`${accountRecoveries.issuedAt} <= clock_timestamp() - ${maximumOutcomeAgeMs} * interval '1 millisecond'`,
          ),
        )
        .orderBy(asc(accountRecoveries.issuedAt), asc(accountRecoveries.accountId))
        .limit(limit)
    },
  }
}
