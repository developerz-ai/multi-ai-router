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

  test("stop flushes what is left", async () => {
    const writer = collectingWriter()
    const recorder = createUsageRecorder(writer)

    recorder.start()
    recorder.record(record())
    await recorder.stop()

    expect(writer.batches).toHaveLength(1)
  })
})

/**
 * A rejected write used to be the end of two hundred records: counted into a stat nothing exported
 * and dropped. Postgres is unavailable for a second far more often than it is unavailable at all,
 * so a batch now gets one more try on the next flush — and both fates are counted separately,
 * because "the database blinked" and "rows are gone" are different incidents.
 */
describe("a write the database refuses", () => {
  /** Fails the first `failures` writes, then behaves. A restart, a failover, a full disk clearing. */
  function flaky(failures: number): UsageWriter & { readonly batches: UsageRecord[][] } {
    const writer = collectingWriter()
    let remaining = failures
    return {
      batches: writer.batches,
      write(batch) {
        if (remaining > 0) {
          remaining -= 1
          return Promise.reject(new Error("write CONNECTION_CLOSED"))
        }
        return writer.write(batch)
      },
    }
  }

  test("goes back for one more try, so a blip loses nothing", async () => {
    const writer = flaky(1)
    const recorder = createUsageRecorder(writer, { batchSize: 2 })

    for (let attempt = 1; attempt <= 2; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()

    // Refused. The records are still held — reporting is late, not lost.
    expect(writer.batches).toHaveLength(0)
    expect(recorder.stats()).toMatchObject({ depth: 2, written: 0, writeDiscarded: 0 })

    await recorder.flush()

    expect(writer.batches.flat().map((held) => held.attempt)).toEqual([1, 2])
    expect(recorder.stats()).toMatchObject({
      depth: 0,
      written: 2,
      writeFailures: 2,
      writeDiscarded: 0,
    })
  })

  test("is retried before anything queued since, so attempts land in the order they happened", async () => {
    const writer = flaky(1)
    const recorder = createUsageRecorder(writer, { batchSize: 2 })

    for (let attempt = 1; attempt <= 2; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()
    for (let attempt = 3; attempt <= 4; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()

    expect(writer.batches.flat().map((held) => held.attempt)).toEqual([1, 2, 3, 4])
  })

  test("is discarded when the retry is refused too — one retry, never a loop", async () => {
    const fates: boolean[] = []
    const recorder = createUsageRecorder(
      { write: () => Promise.reject(new Error("database is down")) },
      { batchSize: 2, onWriteError: ({ discarded }) => void fates.push(discarded) },
    )

    for (let attempt = 1; attempt <= 4; attempt += 1) recorder.record(record({ attempt }))

    await recorder.flush()
    expect(recorder.stats()).toMatchObject({ depth: 4, writeFailures: 2, writeDiscarded: 0 })

    await recorder.flush()
    // The head gave up its place: a batch the writer will never accept must not starve the ones
    // behind it, which is what re-queueing without a ceiling on tries would do.
    expect(recorder.stats()).toMatchObject({ depth: 2, writeFailures: 4, writeDiscarded: 2 })

    await recorder.flush()
    await recorder.flush()
    expect(recorder.stats()).toMatchObject({ depth: 0, writeFailures: 8, writeDiscarded: 4 })
    expect(fates).toEqual([false, true, false, true])
  })

  test("ends the pass rather than burning the whole queue against the same writer", async () => {
    let attempts = 0
    const recorder = createUsageRecorder(
      {
        write: () => {
          attempts += 1
          return Promise.reject(new Error("database is down"))
        },
      },
      { batchSize: 2 },
    )

    for (let attempt = 1; attempt <= 10; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()

    // The writer just refused; the next batch would meet the same database this millisecond.
    expect(attempts).toBe(1)
    expect(recorder.stats().depth).toBe(10)
  })

  test("does not re-observe the retry — a blip must not invent attempts on the dashboard", async () => {
    const observed: number[] = []
    const recorder = createUsageRecorder(flaky(1), {
      batchSize: 2,
      onRecord: (held) => void observed.push(held.attempt),
    })

    for (let attempt = 1; attempt <= 2; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()
    await recorder.flush()

    // Every attempt-level metric is fed from this hook. Twice would be two upstream calls.
    expect(observed).toEqual([1, 2])
  })

  test("counts the batch it is holding as queued, so the depth gauge stays honest", async () => {
    const recorder = createUsageRecorder(flaky(1), { batchSize: 2, maxQueued: 4 })

    for (let attempt = 1; attempt <= 2; attempt += 1) recorder.record(record({ attempt }))
    await recorder.flush()
    for (let attempt = 3; attempt <= 4; attempt += 1) recorder.record(record({ attempt }))

    // Held beside the queue rather than in it: overflow sheds the oldest, and the oldest here is
    // precisely the batch that has not had its retry yet.
    expect(recorder.stats()).toMatchObject({ depth: 4, dropped: 0 })
  })
})

describe("stop() — invisible loss is the one thing this module promises not to do", () => {
  test("records the writer keeps refusing are counted as abandoned, never silently stranded", async () => {
    // The failure case first. Before the count, stop() coalesced onto a pass that ended at the
    // first refusal and returned: the retry batch and everything queued behind it evaporated
    // with the process — neither dropped nor writeFailures moved.
    let abandoned = 0
    const recorder = createUsageRecorder(
      { write: () => Promise.reject(new Error("database is down")) },
      {
        batchSize: 2,
        onAbandoned: (records) => {
          abandoned += records
        },
      },
    )

    for (let attempt = 1; attempt <= 6; attempt += 1) recorder.record(record({ attempt }))
    await recorder.stop()

    // First pass: [1,2] refused, held for retry. Second pass: the retry refused again —
    // discarded and counted — and the pass ends. [3,4,5,6] die with the process, counted.
    expect(abandoned).toBe(4)
    expect(recorder.stats()).toMatchObject({ writeFailures: 4, writeDiscarded: 2 })
  })

  test("gives late records a fresh pass instead of abandoning them behind an ended drain", async () => {
    const writer = collectingWriter()
    const recorder = createUsageRecorder(writer, { batchSize: 2 })

    recorder.record(record({ attempt: 1 }))
    const first = recorder.flush()
    // Enqueued while the first pass is already running: the shutdown race in miniature. stop()
    // coalesces onto `first`, and whichever pass sees this record, none may abandon it.
    recorder.record(record({ attempt: 2 }))
    await recorder.stop()
    await first

    expect(writer.batches.flat().map((held) => held.attempt)).toEqual([1, 2])
    expect(recorder.stats().depth).toBe(0)
  })

  test("a clean shutdown reports nothing abandoned", async () => {
    let calls = 0
    const recorder = createUsageRecorder(collectingWriter(), {
      onAbandoned: () => {
        calls += 1
      },
    })

    recorder.record(record({ attempt: 1 }))
    await recorder.stop()

    expect(calls).toBe(0)
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
