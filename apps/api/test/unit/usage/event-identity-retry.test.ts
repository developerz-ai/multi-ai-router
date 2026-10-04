import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createUsageRecorderFromEnv } from "../../../src/services/usage/fromEnv"
import type { UsageRecord } from "../../../src/services/usage/record"

function event(): UsageRecord {
  return {
    eventId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    clientRequestId: null,
    attempt: 1,
    apiKeyId: null,
    accountId: null,
    poolId: null,
    provider: null,
    sessionKey: null,
    model: null,
    upstreamModel: null,
    ingressDialect: null,
    egressMode: null,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costEstimate: null,
    costBasis: "unknown",
    latencyMs: 1,
    ttfbMs: null,
    routerOverheadMs: 1,
    outcome: "client_error",
    streamed: false,
    httpStatus: null,
    responseStatus: 401,
    errorClass: null,
    startedAt: new Date(),
    finishedAt: new Date(),
  }
}
test("production mapping preserves event IDs and final response facts on batch retries", async () => {
  const attempts: string[][] = []
  const persisted = new Map<string, number | null>()
  let loseAck = true
  const recorder = createUsageRecorderFromEnv({
    records: {
      insertBatch: async ({ attempts: rows }) => {
        attempts.push(rows.map((row) => row.id))
        for (const row of rows)
          if (!persisted.has(row.id)) persisted.set(row.id, row.responseStatus ?? null)
        if (loseAck) {
          loseAck = false
          throw new Error("commit then ack lost")
        }
        return { insertedAttempts: rows.length, insertedTerminals: 0 }
      },
    },
    accounts: { markUsed: async () => {} },
    env: {
      logReasonMaxChars: 200,
      dataPlane: {
        usageQueueMax: 10,
        usageBatchSize: 2,
        usageFlushIntervalMs: 1000,
        usageLogReportIntervalMs: 1000,
      },
    },
    logger: createLogger({ level: "error", write: () => {} }),
  })
  const first = event(),
    second = event()
  recorder.record(first)
  recorder.record(second)
  await recorder.flush()
  await recorder.flush()
  expect(attempts).toEqual([
    [first.eventId, second.eventId],
    [first.eventId, second.eventId],
  ])
  expect(persisted.size).toBe(2)
  expect([...persisted.values()]).toEqual([401, 401])
  expect(recorder.stats().depth).toBe(0)
  await recorder.stop()
})
