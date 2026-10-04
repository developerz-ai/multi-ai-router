import { describe, expect, test } from "bun:test"
import { getTableColumns } from "drizzle-orm"
import type { UsageRecordInsert } from "../../../src/repositories/usage-repository"
import {
  createUsageRecordRepository,
  PG_MAX_BIND_PARAMETERS,
  USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
  USAGE_RECORD_MAX_BATCH_ROWS,
} from "../../../src/repositories/usage-repository"
import { usageRecords } from "../../../src/schema/usage-records"
import { usageRequestTerminals } from "../../../src/schema/usage-request-terminals"
import { transactionHarness } from "./fixtures"

/**
 * `USAGE_RECORD_MAX_BATCH_ROWS` is what `config/env.ts` refuses a `USAGE_BATCH_SIZE`
 * against, and the cost of it being wrong is the whole usage table: one row past
 * Postgres' bind ceiling and every flush is rejected identically, forever, with
 * traffic unaffected and nothing in the table to show for it.
 *
 * So the per-row parameter count is not taken on trust here. The statement the
 * repository would actually put on the wire is built, and its parameters counted —
 * a column added to `usage_records` and filled in by the writer turns this red on
 * the same commit, which is the only thing standing between that column and a
 * ceiling that is quietly one batch too high.
 */

const row: UsageRecordInsert = {
  id: "00000000-0000-0000-0000-000000000002",
  correlationId: "00000000-0000-0000-0000-000000000001",
  clientRequestId: null,
  attempt: 1,
  apiKeyId: null,
  accountId: null,
  poolId: null,
  provider: null,
  sessionKey: null,
  model: "claude-sonnet-5",
  upstreamModel: "claude-sonnet-5",
  ingressDialect: null,
  egressMode: null,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costEstimate: null,
  costBasis: "unknown",
  latencyMs: 0,
  ttfbMs: null,
  routerOverheadMs: 0,
  outcome: "success",
  streamed: false,
  httpStatus: null,
  responseStatus: null,
  errorClass: null,
  createdAt: new Date("2026-06-25T00:00:00.000Z"),
}

/** Follow the production transaction far enough to capture its real raw insert statement. */
async function insertStatement(count: number) {
  const rows = Array.from({ length: count }, () => ({ ...row, id: crypto.randomUUID() }))
  const columns = Object.keys(getTableColumns(usageRecords))
  const h = transactionHarness(({ sql }) => {
    if (!sql.startsWith('insert into "usage_records"')) return []
    return rows.map((entry) => {
      const values: Record<string, unknown> = { ...entry, ingestedAt: new Date() }
      return columns.map((column) => {
        const value = values[column]
        return value instanceof Date ? value.toISOString() : value
      })
    })
  })
  await createUsageRecordRepository(h.db).insertMany(rows)
  expect(h.transactions()).toBe(1)
  const raw = h.statements.filter((entry) => entry.sql.startsWith('insert into "usage_records"'))
  expect(raw).toHaveLength(1)
  const statement = raw[0]
  if (statement === undefined) throw new Error("raw insert absent")
  return { statement, rows }
}

async function boundParameters(count: number): Promise<number> {
  return (await insertStatement(count)).statement.params.length
}

describe("usage insert bind budget", () => {
  test("spends exactly USAGE_RECORD_BIND_PARAMETERS_PER_ROW parameters on one row", async () => {
    expect(await boundParameters(1)).toBe(USAGE_RECORD_BIND_PARAMETERS_PER_ROW)
  })

  test("scales linearly, so the ceiling is a division and not an estimate", async () => {
    expect(await boundParameters(7)).toBe(7 * USAGE_RECORD_BIND_PARAMETERS_PER_ROW)
  })

  test("binds a stable event ID and scopes duplicate suppression to that primary key", async () => {
    const { statement, rows } = await insertStatement(1)
    expect(statement.sql).toContain('"id"')
    expect(statement.sql).toContain("values ($1")
    expect(statement.sql).toContain('on conflict ("id") do nothing')
    expect(statement.sql).toContain("clock_timestamp()")
    expect(statement.params[0]).toBe(rows[0]?.id)
  })

  test("fits a full batch inside Postgres' bind ceiling", () => {
    expect(USAGE_RECORD_MAX_BATCH_ROWS * USAGE_RECORD_BIND_PARAMETERS_PER_ROW).toBeLessThanOrEqual(
      PG_MAX_BIND_PARAMETERS,
    )
  })

  test("is the largest batch that fits — one more row overruns", () => {
    expect(
      (USAGE_RECORD_MAX_BATCH_ROWS + 1) * USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
    ).toBeGreaterThan(PG_MAX_BIND_PARAMETERS)
  })

  test("leaves room for the default batch size many times over", () => {
    // Guards the arithmetic itself: a ceiling below the shipped default would fail
    // boot on a stock configuration.
    expect(USAGE_RECORD_MAX_BATCH_ROWS).toBeGreaterThan(200)
  })
})

test("oversized direct terminal batches and combined receipts use bounded statements in one transaction", async () => {
  const terminals = Array.from({ length: 11000 }, () => ({
    correlationId: crypto.randomUUID(),
    winnerEventId: null,
    apiKeyId: null,
    accountId: null,
    poolId: null,
    provider: null,
    model: null,
    upstreamModel: null,
    outcome: "success" as const,
    errorClass: null,
    responseStatus: 200,
    httpStatus: null,
    attributionKind: "unstarted" as const,
    startedAt: row.createdAt ?? new Date(),
    settledAt: row.createdAt ?? new Date(),
  }))
  const columns = Object.keys(getTableColumns(usageRequestTerminals))
  const h = transactionHarness(({ sql, params }) => {
    if (!sql.startsWith('insert into "usage_request_terminals"')) return []
    const identities = new Set(params)
    return terminals
      .filter((terminal) => identities.has(terminal.correlationId))
      .map((terminal) => {
        const values: Record<string, unknown> = { ...terminal, ingestedAt: new Date() }
        return columns.map((column) =>
          values[column] instanceof Date ? values[column].toISOString() : values[column],
        )
      })
  })
  expect(await createUsageRecordRepository(h.db).insertBatch({ attempts: [], terminals })).toEqual({
    insertedAttempts: 0,
    insertedTerminals: terminals.length,
  })
  expect(h.transactions()).toBe(1)
  const terminalStatements = h.statements.filter((statement) =>
    statement.sql.startsWith('insert into "usage_request_terminals"'),
  )
  const receipts = h.statements.filter((statement) =>
    statement.sql.startsWith('insert into "usage_contributions"'),
  )
  expect(terminalStatements.length).toBeGreaterThan(1)
  expect(receipts.length).toBeGreaterThan(1)
  expect(h.statements.every((statement) => statement.params.length <= PG_MAX_BIND_PARAMETERS)).toBe(
    true,
  )
})
