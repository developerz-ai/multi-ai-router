import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm"
import type { Database } from "../client"
import { usageContributions } from "../schema/usage-contributions"
import { usageRecords } from "../schema/usage-records"
import {
  type UsageRequestTerminalInsert,
  usageRequestTerminals,
} from "../schema/usage-request-terminals"
import { applyUsageContributions } from "./usage-contribution-aggregate"
import {
  attemptContribution,
  terminalContribution,
  UsageHistoryExpired,
  UsageIdentityConflict,
  usagePayloadHash,
} from "./usage-contribution-values"
import { lockUsageHistory } from "./usage-history-lock"
import { PG_MAX_BIND_PARAMETERS, type UsageRecordInsert } from "./usage-repository"

export interface UsageBatchInsert {
  readonly attempts: readonly UsageRecordInsert[]
  readonly terminals: readonly UsageRequestTerminalInsert[]
}
export interface UsageBatchResult {
  readonly insertedAttempts: number
  readonly insertedTerminals: number
}
/** Conservative per-table counts include SQL/default fields, so future columns cannot overflow Bind. */
function* chunks<T>(rows: readonly T[], columns = 1): Generator<T[]> {
  const maximum = Math.floor((PG_MAX_BIND_PARAMETERS - 1) / columns)
  for (let start = 0; start < rows.length; start += maximum)
    yield rows.slice(start, start + maximum)
}
export function createUsageBatchMutation(db: Database) {
  return async ({ attempts, terminals }: UsageBatchInsert): Promise<UsageBatchResult> => {
    if (attempts.length + terminals.length === 0)
      return { insertedAttempts: 0, insertedTerminals: 0 }
    return db.transaction(async (tx) => {
      const { state, dbNow } = await lockUsageHistory(tx)
      const admitted = []
      let insertedAttempts = 0,
        insertedTerminals = 0
      for (const kind of ["attempt", "terminal"] as const) {
        const supplied = kind === "attempt" ? attempts : terminals
        const idOf = (row: UsageRecordInsert | UsageRequestTerminalInsert) =>
          "id" in row ? row.id : row.correlationId
        const unique = new Map<string, UsageRecordInsert | UsageRequestTerminalInsert>()
        for (const row of supplied) {
          const prior = unique.get(idOf(row))
          if (prior !== undefined && usagePayloadHash(prior) !== usagePayloadHash(row))
            throw new UsageIdentityConflict()
          unique.set(idOf(row), row)
        }
        const input = [...unique.values()]
        const ids = input.map(idOf)
        if (ids.length === 0) continue
        const existing = []
        for (const batch of chunks(ids))
          existing.push(
            ...(await tx
              .select()
              .from(usageContributions)
              .where(
                and(eq(usageContributions.kind, kind), inArray(usageContributions.id, batch)),
              )),
          )
        const seen = new Map(existing.map((row) => [row.id, row]))
        const fresh = input.filter((row) => {
          const held = seen.get(idOf(row))
          if (held === undefined) return true
          if (held.source === "live" && held.payloadHash !== usagePayloadHash(row))
            throw new UsageIdentityConflict()
          return false
        })
        for (const row of fresh) {
          const eventAt = "settledAt" in row ? row.settledAt : (row.createdAt ?? dbNow)
          if (
            state.retentionBeforeDay !== null &&
            eventAt.toISOString().slice(0, 10) < state.retentionBeforeDay
          )
            throw new UsageHistoryExpired()
        }
        if (kind === "attempt") {
          const rows = fresh as UsageRecordInsert[]
          const originals = new Map(rows.map((row) => [row.id, row]))
          const legacy = []
          for (const batch of chunks(rows))
            legacy.push(
              ...(await tx
                .select()
                .from(usageRecords)
                .where(
                  inArray(
                    usageRecords.id,
                    batch.map((row) => row.id),
                  ),
                )),
            )
          const written = []
          for (const batch of chunks(rows, Object.keys(getTableColumns(usageRecords)).length))
            written.push(
              ...(await tx
                .insert(usageRecords)
                .values(batch.map((row) => ({ ...row, ingestedAt: sql`clock_timestamp()` })))
                .onConflictDoNothing({ target: usageRecords.id })
                .returning()),
            )
          insertedAttempts = written.length
          const writtenIds = new Set(written.map((row) => row.id))
          for (const row of [...written, ...legacy]) {
            const original = originals.get(row.id)
            if (original === undefined) throw new Error("usage admission input missing")
            admitted.push({
              id: row.id,
              kind,
              day: row.createdAt.toISOString().slice(0, 10),
              source: writtenIds.has(row.id)
                ? ("live" as const)
                : row.ingestedAt === null
                  ? ("legacy_pending" as const)
                  : ("legacy_overlap" as const),
              payloadHash: usagePayloadHash(writtenIds.has(row.id) ? original : row),
              payload: attemptContribution(row, dbNow),
            })
          }
        } else {
          const rows = fresh as UsageRequestTerminalInsert[]
          const originals = new Map(rows.map((row) => [row.correlationId, row]))
          const written = []
          for (const batch of chunks(
            rows,
            Object.keys(getTableColumns(usageRequestTerminals)).length,
          ))
            written.push(
              ...(await tx
                .insert(usageRequestTerminals)
                .values(batch.map((row) => ({ ...row, ingestedAt: sql`clock_timestamp()` })))
                .onConflictDoNothing({ target: usageRequestTerminals.correlationId })
                .returning()),
            )
          insertedTerminals = written.length
          for (const row of written) {
            const original = originals.get(row.correlationId)
            if (original === undefined) throw new Error("usage admission input missing")
            admitted.push({
              id: row.correlationId,
              kind,
              day: row.settledAt.toISOString().slice(0, 10),
              source: "live" as const,
              payloadHash: usagePayloadHash(original),
              payload: terminalContribution(row),
            })
          }
        }
      }
      if (admitted.length) {
        const inserted = []
        for (const batch of chunks(
          admitted,
          Object.keys(getTableColumns(usageContributions)).length,
        ))
          inserted.push(
            ...(await tx
              .insert(usageContributions)
              .values(batch)
              .onConflictDoNothing({ target: [usageContributions.kind, usageContributions.id] })
              .returning()),
          )
        await applyUsageContributions(tx, inserted)
      }
      return { insertedAttempts, insertedTerminals }
    })
  }
}
