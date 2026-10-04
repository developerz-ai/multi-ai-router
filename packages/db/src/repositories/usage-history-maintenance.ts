import { and, eq, sql } from "drizzle-orm"
import type { Database } from "../client"
import { usageAttemptDailyV2, usageRequestDailyV2 } from "../schema/usage-aggregate-v2"
import { usageContributions } from "../schema/usage-contributions"
import { usageDaily } from "../schema/usage-daily"
import { usageHistoryState } from "../schema/usage-history-state"
import { usageRecords } from "../schema/usage-records"
import { usageRequestTerminals } from "../schema/usage-request-terminals"
import { applyUsageContributions } from "./usage-contribution-aggregate"
import { attemptContribution, usagePayloadHash } from "./usage-contribution-values"
import { boundUsageBatch, lockUsageHistory } from "./usage-history-lock"

export function createUsageHistoryMaintenance(db: Database) {
  const backfill = async ({ limit }: { limit: number }) => {
    boundUsageBatch(limit)
    return db.transaction(async (tx) => {
      const { state, dbNow } = await lockUsageHistory(tx)
      const rows = await tx
        .select()
        .from(usageRecords)
        .where(
          sql`not exists (select 1 from ${usageContributions} c where c.kind = 'attempt' and c.id = ${usageRecords.id} and c.source <> 'legacy_pending')`,
        )
        .orderBy(usageRecords.id)
        .limit(limit)
      const days = [...new Set(rows.map((row) => row.createdAt.toISOString().slice(0, 10)))]
      const banked = days.length
        ? await tx
            .selectDistinct({ day: usageDaily.day })
            .from(usageDaily)
            .where(
              sql`${usageDaily.day} in (select jsonb_array_elements_text(${JSON.stringify(days)}::jsonb)::date)`,
            )
        : []
      const baselineDays = new Set(banked.map((row) => row.day))
      const admitted = []
      for (const row of rows) {
        const day = row.createdAt.toISOString().slice(0, 10)
        // NULL IDs may be an old FK deletion after banking; they never prove omitted evidence.
        const expired = state.retentionBeforeDay !== null && day < state.retentionBeforeDay
        const source =
          expired || (row.ingestedAt === null && baselineDays.has(day))
            ? ("legacy_baseline" as const)
            : row.ingestedAt === null
              ? ("legacy_unbanked" as const)
              : ("legacy_overlap" as const)
        const input = {
          id: row.id,
          kind: "attempt" as const,
          day,
          source,
          payloadHash: usagePayloadHash(row),
          payload: attemptContribution(row, dbNow),
        }
        const [receipt] = await tx
          .insert(usageContributions)
          .values(input)
          .onConflictDoUpdate({
            target: [usageContributions.kind, usageContributions.id],
            set: { source },
            setWhere: eq(usageContributions.source, "legacy_pending"),
          })
          .returning()
        if (receipt !== undefined) admitted.push(receipt)
      }
      await applyUsageContributions(tx, admitted)
      return { processed: rows.length, remaining: rows.length === limit }
    })
  }
  const rollupDay = async (at: Date) =>
    db.transaction(async (tx) => {
      const { state, dbNow } = await lockUsageHistory(tx)
      const day = at.toISOString().slice(0, 10)
      if (
        day >= dbNow.toISOString().slice(0, 10) ||
        (state.retentionBeforeDay !== null && day < state.retentionBeforeDay)
      )
        return 0
      const [count] = await tx.execute(
        sql`select count(*)::int as count from ${usageContributions} where day = ${day}::date and source in ('live','legacy_unbanked','legacy_overlap')`,
      )
      await tx.delete(usageAttemptDailyV2).where(eq(usageAttemptDailyV2.day, day))
      await tx.delete(usageRequestDailyV2).where(eq(usageRequestDailyV2.day, day))
      await applyUsageContributions(tx, [], day)
      return Number(count?.count ?? 0)
    })
  const deleteOlderThan = async (cutoff: Date, limit: number) => {
    boundUsageBatch(limit)
    return db.transaction(async (tx) => {
      const { state, dbNow } = await lockUsageHistory(tx)
      const requested = cutoff < dbNow ? cutoff : dbNow
      const day = requested.toISOString().slice(0, 10)
      const horizon =
        state.retentionBeforeDay !== null && state.retentionBeforeDay > day
          ? state.retentionBeforeDay
          : day
      await tx
        .update(usageHistoryState)
        .set({ retentionBeforeDay: horizon, updatedAt: dbNow })
        .where(eq(usageHistoryState.id, "v2"))
      let deleted = 0
      for (const table of [usageDaily, usageAttemptDailyV2, usageRequestDailyV2]) {
        const ids = await tx
          .select({ id: table.id })
          .from(table)
          .where(sql`${table.day} < ${horizon}::date`)
          .orderBy(table.day, table.id)
          .limit(limit - deleted)
        if (ids.length)
          deleted += (
            await tx
              .delete(table)
              .where(
                sql`${table.id} in (select jsonb_array_elements_text(${JSON.stringify(ids.map((row) => row.id))}::jsonb)::uuid)`,
              )
              .returning({ id: table.id })
          ).length
        if (deleted >= limit) return deleted
      }
      const ids = await tx
        .select({ id: usageContributions.id, kind: usageContributions.kind })
        .from(usageContributions)
        .where(sql`${usageContributions.day} < ${horizon}::date`)
        .orderBy(usageContributions.day, usageContributions.id)
        .limit(limit - deleted)
      for (const receipt of ids)
        deleted += (
          await tx
            .delete(usageContributions)
            .where(
              and(eq(usageContributions.id, receipt.id), eq(usageContributions.kind, receipt.kind)),
            )
            .returning({ id: usageContributions.id })
        ).length
      return deleted
    })
  }
  const deleteRetainedHistory = async ({
    retentionDays,
    limit,
  }: {
    retentionDays: number
    limit: number
  }) => {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
      throw new Error("usage retention days outside bounds")
    const [clock] = await db.execute(sql`select clock_timestamp() as now`)
    return deleteOlderThan(
      new Date(new Date(clock?.now as string).getTime() - retentionDays * 86400000),
      limit,
    )
  }
  return { backfill, rollupDay, deleteOlderThan, deleteRetainedHistory }
}

export function createUsageDetailRetention(db: Database) {
  const deleteOlderThan = async (cutoff: Date, limit: number) => {
    boundUsageBatch(limit)
    return db.transaction(async (tx) => {
      const { dbNow, state } = await lockUsageHistory(tx)
      const before = cutoff < dbNow ? cutoff : dbNow
      const ids = await tx
        .select({ id: usageRecords.id })
        .from(usageRecords)
        .where(
          sql`${usageRecords.createdAt} < ${before.toISOString()} and (exists (select 1 from ${usageContributions} c where c.kind = 'attempt' and c.id = ${usageRecords.id} and c.source <> 'legacy_pending') or (${state.retentionBeforeDay}::date is not null and ${usageRecords.createdAt} < ${state.retentionBeforeDay}::date))`,
        )
        .orderBy(usageRecords.createdAt, usageRecords.id)
        .limit(limit)
      let deleted = ids.length
        ? (
            await tx
              .delete(usageRecords)
              .where(
                sql`${usageRecords.id} in (select jsonb_array_elements_text(${JSON.stringify(ids.map((row) => row.id))}::jsonb)::uuid)`,
              )
              .returning({ id: usageRecords.id })
          ).length
        : 0
      if (deleted < limit) {
        const terminalIds = await tx
          .select({ id: usageRequestTerminals.correlationId })
          .from(usageRequestTerminals)
          .where(sql`${usageRequestTerminals.settledAt} < ${before.toISOString()}`)
          .orderBy(usageRequestTerminals.settledAt, usageRequestTerminals.correlationId)
          .limit(limit - deleted)
        if (terminalIds.length)
          deleted += (
            await tx
              .delete(usageRequestTerminals)
              .where(
                sql`${usageRequestTerminals.correlationId} in (select jsonb_array_elements_text(${JSON.stringify(terminalIds.map((row) => row.id))}::jsonb)::uuid)`,
              )
              .returning({ id: usageRequestTerminals.correlationId })
          ).length
      }
      return deleted
    })
  }
  const deleteRetainedBatch = async ({
    retentionDays,
    limit,
  }: {
    retentionDays: number
    limit: number
  }) => {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
      throw new Error("usage retention days outside bounds")
    const [clock] = await db.execute(sql`select clock_timestamp() as now`)
    return deleteOlderThan(
      new Date(new Date(clock?.now as string).getTime() - retentionDays * 86400000),
      limit,
    )
  }
  return { deleteOlderThan, deleteRetainedBatch }
}
