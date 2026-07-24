import { describe, expect, test } from "bun:test"
import {
  correlationIdFrom,
  createUsageRecorder,
  toUsageRecordRow,
  type UsageRecord,
  type UsageWriter,
} from "../../../src/services/usage"

/**
 * Usage accounting is off the request path, and these tests pin the consequences: `record()`
 * returns immediately even when the writer never settles, and an overflowing queue sheds instead of
 * applying backpressure to whoever is calling it.
 */

const AT = new Date("2026-01-01T12:00:00.000Z")

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    correlationId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    apiKeyId: "key-1",
    accountId: "acct-1",
    provider: "anthropic-api",
    sessionKey: "session-1",
    model: "claude-opus-5",
    upstreamModel: "claude-opus-5",
    tokensIn: 10,
    tokensOut: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    latencyMs: 120,
    routerOverheadMs: 3,
    outcome: "success",
    streamed: true,
    httpStatus: 200,
    errorClass: null,
    startedAt: AT,
    finishedAt: AT,
    ...overrides,
  }
}

function collectingWriter(): UsageWriter & { readonly batches: UsageRecord[][] } {
  const batches: UsageRecord[][] = []
  return {
    batches,
    write(batch) {
      batches.push([...batch])
      return Promise.resolve()
    },
  }
}

describe("usage recorder", () => {
  test("records nothing on the request path — the batch reaches the writer on flush", async () => {
    const writer = collectingWriter()
    const recorder = createUsageRecorder(writer)

    recorder.record(record())
    expect(writer.batches).toHaveLength(0)
    expect(recorder.stats().depth).toBe(1)

    await recorder.flush()
    expect(writer.batches).toEqual([[record()]])
  })

  test("writes in batches of the configured size", async () => {
    const writer = collectingWriter()
    const recorder = createUsageRecorder(writer, { batchSize: 2 })

    for (let attempt = 1; attempt <= 5; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()

    expect(writer.batches.map((batch) => batch.length)).toEqual([2, 2, 1])
    expect(recorder.stats().written).toBe(5)
  })

  test("never blocks on a writer that has not settled", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const recorder = createUsageRecorder({ write: () => gate }, { batchSize: 1 })

    recorder.record(record())
    const flushing = recorder.flush()

    // The writer is stuck, and recording still returns immediately.
    for (let attempt = 2; attempt <= 100; attempt += 1) recorder.record(record({ attempt }))
    expect(recorder.stats().depth).toBe(99)

    release()
    await flushing
  })

  test("sheds the oldest under overflow rather than applying backpressure", () => {
    const shed: UsageRecord[] = []
    const recorder = createUsageRecorder(collectingWriter(), {
      maxQueued: 3,
      onShed: (dropped) => void shed.push(dropped),
    })

    for (let attempt = 1; attempt <= 6; attempt += 1) recorder.record(record({ attempt }))

    expect(recorder.stats()).toMatchObject({ depth: 3, dropped: 3 })
    expect(shed).toHaveLength(3)
  })

  test("a failing writer is counted, not retried into a loop", async () => {
    const failures: unknown[] = []
    const recorder = createUsageRecorder(
      { write: () => Promise.reject(new Error("database is down")) },
      { batchSize: 2, onWriteError: (error) => void failures.push(error) },
    )

    for (let attempt = 1; attempt <= 4; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()

    expect(recorder.stats()).toMatchObject({ depth: 0, writeFailures: 4 })
    expect(failures).toHaveLength(2)
  })

  test("stop flushes what is left", async () => {
    const writer = collectingWriter()
    const recorder = createUsageRecorder(writer)

    recorder.start()
    recorder.record(record())
    await recorder.stop()

    expect(writer.batches).toHaveLength(1)
  })
})

describe("persistence shape", () => {
  test("maps onto the row the schema defines", () => {
    const row = toUsageRecordRow(record())

    expect(row).toMatchObject({
      correlationId: "11111111-1111-4111-8111-111111111111",
      attempt: 1,
      model: "claude-opus-5",
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      routerOverheadMs: 3,
      outcome: "success",
    })
  })

  test("replaces a request id the uuid column could not hold", () => {
    expect(correlationIdFrom("req-42")).toMatch(/^[0-9a-f-]{36}$/)
    expect(correlationIdFrom("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    )
  })
})
