import { afterAll, beforeAll } from "bun:test"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createUsageHistoryRepository } from "../../src/repositories/usage-history-repository"
import {
  createUsageRecordRepository,
  type UsageRecordInsert,
} from "../../src/repositories/usage-repository"
import type { UsageRequestTerminalInsert } from "../../src/schema/usage-request-terminals"

export const historyUrl = process.env.DATABASE_URL ?? ""
/** Each suite owns a disposable database, so retention watermarks cannot touch other fixtures. */
export function usageHistoryFixture() {
  let admin: DatabaseHandle | undefined, handle: DatabaseHandle | undefined
  let fixtureUrl = ""
  const name = `usage_history_${crypto.randomUUID().replaceAll("-", "")}`
  beforeAll(async () => {
    if (!historyUrl) return
    admin = createDatabase({ url: historyUrl, maxConnections: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    const uri = new URL(historyUrl)
    uri.pathname = `/${name}`
    fixtureUrl = uri.toString()
    await runMigrations({ url: uri.toString(), migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url: uri.toString(), maxConnections: 1 })
  })
  afterAll(async () => {
    try {
      await handle?.close()
    } finally {
      try {
        await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
      } finally {
        await admin?.close()
      }
    }
  })
  const get = () => {
    if (!handle) throw new Error("fixture uninitialized")
    return handle
  }
  return {
    url: () => fixtureUrl,
    get,
    db: () => get().db,
    usage: () => createUsageRecordRepository(get().db),
    history: () => createUsageHistoryRepository(get().db),
    window: { from: new Date("1984-01-01"), to: new Date("1984-02-01") },
  }
}
export function historyAttempt(over: Partial<UsageRecordInsert> = {}): UsageRecordInsert {
  return {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    model: null,
    accountId: null,
    apiKeyId: null,
    poolId: null,
    outcome: "success",
    createdAt: new Date("1984-01-02T12:00:00Z"),
    tokensIn: 3,
    tokensOut: 2,
    costEstimate: "0.100000",
    costBasis: "metered",
    ...over,
  }
}
export function historyTerminal(
  row: UsageRecordInsert,
  over: Partial<UsageRequestTerminalInsert> = {},
): UsageRequestTerminalInsert {
  return {
    correlationId: row.correlationId,
    winnerEventId: row.id,
    apiKeyId: row.apiKeyId ?? null,
    accountId: row.accountId ?? null,
    poolId: row.poolId ?? null,
    provider: null,
    model: row.model ?? null,
    upstreamModel: null,
    outcome: "success",
    errorClass: null,
    responseStatus: 200,
    httpStatus: 200,
    attributionKind: "winning-attempt",
    startedAt: row.createdAt ?? new Date("1984-01-02"),
    settledAt: new Date("1984-01-03T00:01:00Z"),
    ...over,
  }
}
