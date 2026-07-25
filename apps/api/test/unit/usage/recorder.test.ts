import { describe, expect, test } from "bun:test"
import {
  CredentialDecryptError,
  CreditsExhaustedError,
  QuotaExhaustedError,
} from "@multi-ai-router/core"
import {
  clientRequestIdFrom,
  correlationIdFrom,
  createUsageRecorder,
  outcomeOf,
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
    clientRequestId: "req-42",
    attempt: 1,
    apiKeyId: "key-1",
    accountId: "acct-1",
    poolId: "pool-1",
    provider: "anthropic-api",
    sessionKey: "session-1",
    model: "sonnet",
    upstreamModel: "glm-4.7",
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    tokensIn: 10,
    tokensOut: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    costEstimate: null,
    costBasis: "unknown",
    latencyMs: 120,
    ttfbMs: 40,
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
      model: "sonnet",
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      routerOverheadMs: 3,
      outcome: "success",
    })
  })

  test("drops nothing — every field on the record reaches a column", () => {
    const row = toUsageRecordRow(record())

    // Each of these was assembled on the request path and silently discarded by the mapping, so
    // the record's own documentation described data that existed nowhere.
    expect(row).toMatchObject({
      clientRequestId: "req-42",
      poolId: "pool-1",
      upstreamModel: "glm-4.7",
      ingressDialect: "anthropic",
      egressMode: "passthrough",
      ttfbMs: 40,
      streamed: true,
      httpStatus: 200,
      errorClass: null,
    })
  })

  test("the client's model and the aliased one stay separate facts", () => {
    // "The client asked for sonnet, we sent glm-4.7." The alias map is mutable operator config, so
    // re-deriving this later answers what we *would* send, never what we did.
    const row = toUsageRecordRow(record())
    expect(row.model).toBe("sonnet")
    expect(row.upstreamModel).toBe("glm-4.7")
  })

  test("an unmeasured ttfb is null, never zero", () => {
    expect(toUsageRecordRow(record({ ttfbMs: null })).ttfbMs).toBeNull()
  })
})

describe("correlation id vs. the client's request id", () => {
  test("a caller-supplied id never becomes the join key", () => {
    // `requestId()` honors any `[A-Za-z0-9_.:-]{1,128}` the client sends. Two clients both sending
    // `req-1` must not have their attempt chains merged, quite apart from the uuid column.
    expect(correlationIdFrom("req-42")).toMatch(/^[0-9a-f-]{36}$/)
    expect(correlationIdFrom("req-42")).not.toBe(correlationIdFrom("req-42"))
  })

  test("the caller's id is kept instead of discarded", () => {
    expect(clientRequestIdFrom("req-42")).toBe("req-42")
  })

  test("a router-minted id is the correlation id and nothing else", () => {
    const minted = "11111111-1111-4111-8111-111111111111"
    expect(correlationIdFrom(minted)).toBe(minted)
    expect(clientRequestIdFrom(minted)).toBeNull()
  })
})

describe("outcome of a thrown error", () => {
  test("a router error reports under its own stable outcome", () => {
    expect(outcomeOf(new QuotaExhaustedError("spent"))).toBe("quota_exhausted")
    expect(outcomeOf(new CreditsExhaustedError("drained"))).toBe("credits_exhausted")
    expect(outcomeOf(new CredentialDecryptError("bad key"))).toBe("credential_decrypt_failed")
  })

  test("an unclassified throw is a router fault, not an invented upstream timeout", () => {
    expect(outcomeOf(new TypeError("undefined is not a function"))).toBe("router_error")
    expect(outcomeOf("not an error at all")).toBe("router_error")
  })
})
