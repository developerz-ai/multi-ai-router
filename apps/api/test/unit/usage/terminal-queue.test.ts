import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createUsageRecorder, type UsageRequestTerminal } from "../../../src/services/usage"
import { createUsageRecorderFromEnv } from "../../../src/services/usage/fromEnv"

const terminal = (correlationId: string): UsageRequestTerminal => ({
  correlationId,
  winnerEventId: null,
  apiKeyId: null,
  accountId: null,
  poolId: null,
  provider: null,
  model: "client-model",
  upstreamModel: null,
  outcome: "client_error",
  errorClass: "client_cancelled",
  responseStatus: 499,
  httpStatus: null,
  startedAt: new Date("2026-01-01T23:59:59Z"),
  settledAt: new Date("2026-01-02T00:00:01Z"),
  attributionKind: "unstarted",
})

test("production terminal-only flush persists its owner without stamping account use", async () => {
  const persisted: UsageRequestTerminal[] = []
  let stamps = 0
  let observed = 0
  const recorder = createUsageRecorderFromEnv({
    records: {
      async insertBatch({ attempts, terminals }) {
        expect(attempts).toHaveLength(0)
        persisted.push(...terminals)
        return { insertedAttempts: 0, insertedTerminals: terminals.length }
      },
    },
    accounts: {
      async markUsed() {
        stamps++
      },
    },
    env: {
      logReasonMaxChars: 200,
      dataPlane: {
        usageQueueMax: 10,
        usageBatchSize: 2,
        usageFlushIntervalMs: 1_000,
        usageLogReportIntervalMs: 1_000,
      },
    },
    logger: createLogger({ level: "error", write: () => {} }),
    onRecord: () => observed++,
  })
  const event = { ...terminal(crypto.randomUUID()), accountId: "winning-account" }
  recorder.recordTerminal(event)
  await recorder.flush()
  expect(persisted).toEqual([event])
  expect(stamps).toBe(0)
  expect(observed).toBe(0)
  await recorder.stop()
})

test("terminal retries retain identity and do not observe an invented attempt", async () => {
  const event = terminal(crypto.randomUUID())
  const writes: UsageRequestTerminal[][] = []
  let observations = 0
  const recorder = createUsageRecorder(
    {
      async write(attempts, terminals = []) {
        expect(attempts).toHaveLength(0)
        writes.push([...terminals])
        if (writes.length === 1) throw new Error("acknowledgement lost")
      },
    },
    { onRecord: () => observations++ },
  )
  recorder.recordTerminal(event)
  expect(writes).toHaveLength(0)
  await recorder.flush()
  expect(recorder.stats().depth).toBe(1)
  await recorder.flush()
  expect(writes).toEqual([[event], [event]])
  expect(observations).toBe(0)
  expect(recorder.stats().written).toBe(1)
  expect(recorder.stats().depth).toBe(0)
})

test("terminal overflow and rejected retry count loss within the same queue ceiling", async () => {
  const writes: string[][] = []
  const failures: number[] = []
  const recorder = createUsageRecorder(
    {
      async write(_attempts, terminals = []) {
        writes.push(terminals.map((event) => event.correlationId))
        throw new Error("unavailable")
      },
    },
    {
      maxQueued: 2,
      batchSize: 1,
      onWriteError: ({ batch, terminals }) => failures.push(batch.length + terminals.length),
    },
  )
  recorder.recordTerminal(terminal("oldest"))
  recorder.recordTerminal(terminal("middle"))
  recorder.recordTerminal(terminal("newest"))
  expect(recorder.stats().dropped).toBe(1)
  await recorder.flush()
  await recorder.flush()
  expect(writes).toEqual([["middle"], ["middle"]])
  expect(failures).toEqual([1, 1])
  expect(recorder.stats().writeDiscarded).toBe(1)
  expect(recorder.stats().depth).toBe(1)
})
