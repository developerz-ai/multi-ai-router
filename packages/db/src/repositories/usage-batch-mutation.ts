import { and, eq, inArray, sql } from "drizzle-orm"
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
import type { UsageRecordInsert } from "./usage-repository"

export interface UsageBatchInsert {
  readonly attempts: readonly UsageRecordInsert[]
  readonly terminals: readonly UsageRequestTerminalInsert[]
}
export interface UsageBatchResult {
  readonly insertedAttempts: number
  readonly insertedTerminals: number
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
        const existing = await tx
          .select()
          .from(usageContributions)
          .where(and(eq(usageContributions.kind, kind), inArray(usageContributions.id, ids)))
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
          const legacy =
            rows.length === 0
              ? []
              : await tx
                  .select()
                  .from(usageRecords)
                  .where(
                    inArray(
                      usageRecords.id,
                      rows.map((row) => row.id),
                    ),
                  )
          const written =
            rows.length === 0
              ? []
              : await tx
                  .insert(usageRecords)
                  .values(rows.map((row) => ({ ...row, ingestedAt: sql`clock_timestamp()` })))
                  .onConflictDoNothing({ target: usageRecords.id })
                  .returning()
          insertedAttempts = written.length
          const writtenIds = new Set(written.map((row) => row.id))
          for (const row of [...written, ...legacy]) {
            const original = rows.find((input) => input.id === row.id)
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
          const written =
            rows.length === 0
              ? []
              : await tx
                  .insert(usageRequestTerminals)
                  .values(rows.map((row) => ({ ...row, ingestedAt: sql`clock_timestamp()` })))
                  .onConflictDoNothing({ target: usageRequestTerminals.correlationId })
                  .returning()
          insertedTerminals = written.length
          for (const row of written) {
            const original = rows.find((input) => input.correlationId === row.correlationId)
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
        const inserted = await tx
          .insert(usageContributions)
          .values(admitted)
          .onConflictDoNothing({ target: [usageContributions.kind, usageContributions.id] })
          .returning()
        await applyUsageContributions(tx, inserted)
      }
      return { insertedAttempts, insertedTerminals }
    })
  }
}
