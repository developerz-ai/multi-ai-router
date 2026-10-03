import { expect, test } from "bun:test"
import type { UsageRecord } from "../../../src/services/usage/record"
import { createUsageRecorder } from "../../../src/services/usage/recorder"

const record: UsageRecord = {
  eventId: crypto.randomUUID(),
  correlationId: crypto.randomUUID(),
  clientRequestId: null,
  attempt: 1,
  apiKeyId: null,
  accountId: null,
  poolId: null,
  provider: null,
  sessionKey: null,
  model: "model",
  upstreamModel: "model",
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
  outcome: "success",
  streamed: false,
  httpStatus: 200,
  responseStatus: 200,
  errorClass: null,
  startedAt: new Date(0),
  finishedAt: new Date(1),
}

test("usage shutdown reports unresolved in-flight records and refuses admission/restart until settled", async () => {
  let release: (() => void) | undefined
  const stalled = new Promise<void>((resolve) => {
    release = resolve
  })
  const abandoned: number[] = []
  let writes = 0
  let overflowReports = 0
  const recorder = createUsageRecorder(
    {
      write: async () => {
        writes++
        await stalled
      },
    },
    {
      shutdownDrainMs: 5,
      onShed: () => {
        overflowReports++
      },
      onAbandoned: (count) => abandoned.push(count),
    },
  )
  recorder.record(record)
  const flight = recorder.flush()
  await recorder.stop()
  expect(abandoned).toEqual([1])
  recorder.start()
  recorder.record(record)
  expect(recorder.stats().rejectedAfterStop).toBe(1)
  expect(overflowReports).toBe(0)
  expect(writes).toBe(1)
  release?.()
  await flight
  await new Promise((resolve) => setTimeout(resolve, 0))
  recorder.start()
  recorder.record(record)
  await recorder.stop()
  expect(recorder.stats().written).toBe(2)
})

test("usage does not start later queued batches when a held write settles after deadline", async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  const recorder = createUsageRecorder(
    {
      write: async () => {
        writes++
        await held
      },
    },
    {
      shutdownDrainMs: 5,
      batchSize: 1,
    },
  )
  recorder.record(record)
  recorder.record(record)
  const flight = recorder.flush()
  await recorder.stop()
  release?.()
  await flight
  expect(writes).toBe(1)
  expect(recorder.stats().depth).toBe(1)
})
