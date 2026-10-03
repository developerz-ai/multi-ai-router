import { and, eq, exists, lte, ne, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { accounts } from "../schema/accounts"
import { quotaWindows } from "../schema/quota-windows"
import type { AccountRepository } from "./account-types"

export function createQuotaWindowMutations(
  db: DatabaseExecutor,
): Pick<AccountRepository, "upsertQuotaWindow" | "clearObservedQuotaWindow"> {
  return {
    upsertQuotaWindow: async (accountId, state) => {
      const values = {
        utilization: state.utilization ?? null,
        utilizationSource: state.utilizationSource,
        resetsAt: state.resetsAt ?? null,
        resetSource: state.resetSource,
        lastCheckedAt: state.lastCheckedAt,
      }
      const incomingAt = sql`${state.lastCheckedAt.toISOString()}::timestamptz`
      const equalTime = sql`${quotaWindows.lastCheckedAt} = ${incomingAt}`
      const moreUsed = sql`(${values.utilization}::double precision is not null and (${quotaWindows.utilization} is null or ${values.utilization}::double precision > ${quotaWindows.utilization}))`
      const laterReset = sql`(${values.resetsAt?.toISOString() ?? null}::timestamptz is not null and (${quotaWindows.resetsAt} is null or ${values.resetsAt?.toISOString() ?? null}::timestamptz > ${quotaWindows.resetsAt}))`
      const [written] = await db
        .insert(quotaWindows)
        .values({ accountId, window: state.window, ...values })
        .onConflictDoUpdate({
          target: [quotaWindows.accountId, quotaWindows.window],
          set: {
            ...values,
            retiredAt: null,
            utilization: sql`case when ${equalTime} then greatest(${quotaWindows.utilization}, ${values.utilization}::double precision) else ${values.utilization}::double precision end`,
            utilizationSource: sql`case when ${equalTime} and not ${moreUsed} then ${quotaWindows.utilizationSource} else ${values.utilizationSource}::utilization_source end`,
            resetsAt: sql`case when ${equalTime} then greatest(${quotaWindows.resetsAt}, ${values.resetsAt?.toISOString() ?? null}::timestamptz) else ${values.resetsAt?.toISOString() ?? null}::timestamptz end`,
            resetSource: sql`case when ${equalTime} and not ${laterReset} then ${quotaWindows.resetSource} else ${values.resetSource}::reset_source end`,
            revision: sql`${quotaWindows.revision} + 1`,
          },
          setWhere: sql`${quotaWindows.lastCheckedAt} < ${incomingAt} or (${equalTime} and ${quotaWindows.retiredAt} is null and (${moreUsed} or ${laterReset}))`,
        })
        .returning()
      if (written !== undefined) return written
      // A rejected stale reading must return held evidence rather than pretend its input committed.
      const [held] = await db
        .select()
        .from(quotaWindows)
        .where(and(eq(quotaWindows.accountId, accountId), eq(quotaWindows.window, state.window)))
      if (held === undefined)
        throw new Error("upsertQuotaWindow: account or window removed during write")
      return held
    },
    clearObservedQuotaWindow: async ({ accountId, window, expected, now }) => {
      const [row] = await db
        .update(quotaWindows)
        .set({
          utilization: null,
          retiredAt: sql`clock_timestamp()`,
          utilizationSource: "none",
          resetsAt: null,
          resetSource: "unknown",
          revision: sql`${quotaWindows.revision} + 1`,
        })
        .where(
          and(
            eq(quotaWindows.accountId, accountId),
            eq(quotaWindows.window, window),
            eq(quotaWindows.revision, expected.revision),
            eq(quotaWindows.resetsAt, expected.resetsAt),
            exists(
              db
                .select({ id: accounts.id })
                .from(accounts)
                .where(and(eq(accounts.id, accountId), ne(accounts.status, "exhausted"))),
            ),
            // Caller now is a deterministic scheduler cutoff, DB clock prevents fast host early expiry.
            lte(quotaWindows.resetsAt, now),
            lte(quotaWindows.resetsAt, sql`clock_timestamp()`),
          ),
        )
        .returning()
      return row
    },
  }
}
