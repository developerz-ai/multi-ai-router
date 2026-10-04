import { eq, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { usageHistoryState } from "../schema/usage-history-state"

/** Same single-connection transaction owns admission/repair/retention; no nested pool query. */
export async function lockUsageHistory(tx: DatabaseExecutor) {
  await tx
    .insert(usageHistoryState)
    .values({ id: "v2" })
    .onConflictDoNothing({ target: usageHistoryState.id })
  const [state] = await tx
    .select()
    .from(usageHistoryState)
    .where(eq(usageHistoryState.id, "v2"))
    .for("update")
  if (state === undefined) throw new Error("usage history state missing")
  const [clock] = await tx.execute(sql`select clock_timestamp() as now`)
  return { state, dbNow: new Date(clock?.now as string) }
}
export function boundUsageBatch(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("usage maintenance batch outside bounds")
}
