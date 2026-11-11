import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createMetrics } from "../../../src/observability"
import type { UsageRecord } from "../../../src/services/usage"
import { createUsageRecorderFromEnv } from "../../../src/services/usage"
import { isTransientDatabaseError, type TrailingTimer } from "../../../src/services/usage/fromEnv"

/**
 * The production recorder's voice. A metric says a batch was refused; a log line says *which*
 * batch and *why*, and it is the only place the database's own complaint survives.
 *
 * Two properties are load-bearing. A refused batch that is going back for its retry is a `warn`
 * and the same batch refused twice is an `error`, so the line an operator wakes up for is the one
 * where rows actually stopped existing. And the reason is bounded: a driver names the statement it
 * refused, a usage statement carries thousands of bind parameters, and a log line that long is how
 * the rest of the incident scrolls out of the buffer.
 */

const AT = new Date("2026-01-01T12:00:00.000Z")

const ENV = {
  logReasonMaxChars: 200,
  dataPlane: {
    usageQueueMax: 100,
    usageBatchSize: 2,
    usageFlushIntervalMs: 1_000,
    usageLogReportIntervalMs: 60_000,
  },
}

function record(attempt: number): UsageRecord {
  return {
    eventId: crypto.randomUUID(),
    correlationId: "11111111-1111-4111-8111-111111111111",
    clientRequestId: null,
    attempt,
    apiKeyId: "key-1",
    accountId: "acct-1",
    poolId: null,
    provider: "anthropic-api",
    sessionKey: null,
    model: "sonnet",
    upstreamModel: null,
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    tokensIn: 10,
    tokensOut: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costEstimate: null,
    costBasis: "unknown",
    latencyMs: 120,
    ttfbMs: 40,
    routerOverheadMs: 3,
    outcome: "success",
    streamed: false,
    httpStatus: 200,
    responseStatus: 200,
    errorClass: null,
    startedAt: AT,
    finishedAt: AT,
  }
}

interface Line {
  readonly level: string
  readonly msg: string
  readonly reason?: string
  readonly records?: number
  readonly dropped?: number
}

interface HarnessOptions {
  readonly now?: () => number
  readonly timer?: TrailingTimer
  readonly queueMax?: number
}

function harness(reject: () => Error, options: HarnessOptions = {}) {
  const lines: Line[] = []
  const recorder = createUsageRecorderFromEnv({
    records: { insertBatch: () => Promise.reject(reject()) },
    accounts: { markUsed: () => Promise.resolve() },
    env: {
      ...ENV,
      dataPlane: {
        ...ENV.dataPlane,
        usageQueueMax: options.queueMax ?? ENV.dataPlane.usageQueueMax,
      },
    },
    logger: createLogger({
      level: "debug",
      write: (line) => void lines.push(JSON.parse(line) as Line),
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timer === undefined ? {} : { timer: options.timer }),
  })
  return { lines, recorder }
}

describe("a refused usage batch, as an operator reads it", () => {
  test("warns while it still has a retry left, and only errors once records are gone", async () => {
    const { lines, recorder } = harness(() => new Error("write CONNECTION_CLOSED"))

    recorder.record(record(1))
    recorder.record(record(2))
    await recorder.flush()

    expect(lines).toMatchObject([
      { level: "warn", msg: expect.stringContaining("retrying it on the next flush"), records: 2 },
    ])

    await recorder.flush()

    // Same two records, refused a second time. This is the line that means data loss, and it is
    // the only one at `error` — a deployment that pages on the warn would page on every blip.
    expect(lines[1]).toMatchObject({
      level: "error",
      msg: "usage batch write failed twice — records lost, traffic unaffected",
      records: 2,
    })
  })

  test("quotes the database's complaint, bounded — the statement is not the message", async () => {
    // postgres.js attaches the query it refused. A usage batch binds thousands of parameters, so
    // an unbounded reason buries every other line of the incident.
    const { lines, recorder } = harness(
      () => new Error(`insert into "usage_records" ${"$1, ".repeat(5_000)}`),
    )

    recorder.record(record(1))
    await recorder.flush()

    const reason = lines[0]?.reason ?? ""
    expect(reason).toStartWith('insert into "usage_records"')
    expect(reason.length).toBeLessThan(256)
  })

  test("a wrapped refusal speaks its cause first — the wrapper names the statement, not the reason", async () => {
    // drizzle's "Failed query: …" carries the driver's complaint one `cause` down; logging only
    // the wrapper once hid a bind-time failure behind the statement it never reached.
    const { lines, recorder } = harness(
      () =>
        new Error(`Failed query: update "accounts" set "last_used_at" = greatest($1)`, {
          cause: new Error("Received an instance of Date"),
        }),
    )

    recorder.record(record(1))
    await recorder.flush()

    const reason = lines[0]?.reason ?? ""
    expect(reason).toStartWith("Received an instance of Date ← ")
    expect(reason).toContain("Failed query")
  })

  test("a credential-bearing cause survives the chain-join scrubbed, never verbatim", async () => {
    // The failure case first: the cause quotes DATABASE_URL back. The chain must still join —
    // the complaint is real — but the credential must not reach the line.
    const { lines, recorder } = harness(
      () =>
        new Error("Failed query: select 1", {
          cause: new Error("connect failed: postgres://router:s3cret-pw@db.internal:5432/router"),
        }),
    )

    recorder.record(record(1))
    await recorder.flush()

    const reason = lines[0]?.reason ?? ""
    expect(reason).toStartWith("connect failed:")
    expect(reason).toContain("db.internal")
    expect(reason).not.toContain("s3cret-pw")
    expect(reason).not.toContain("router:s3cret")
  })

  test("a multi-address connect refusal reads as its sub-errors, not as an empty AggregateError", async () => {
    // The shape Bun throws when Postgres is down: AggregateError, message "", payload in .errors.
    const { lines, recorder } = harness(
      () =>
        new AggregateError([
          new Error("connect ECONNREFUSED ::1:5432"),
          new Error("connect ECONNREFUSED 127.0.0.1:5432"),
        ]),
    )

    recorder.record(record(1))
    await recorder.flush()

    const reason = lines[0]?.reason ?? ""
    expect(reason).toContain("connect ECONNREFUSED ::1:5432")
    expect(reason).toContain("connect ECONNREFUSED 127.0.0.1:5432")
  })

  test("says it once per window however many batches are refused", async () => {
    const trailing: (() => void)[] = []
    const { lines, recorder } = harness(() => new Error("database is down"), {
      now: () => 1_000,
      timer: (fire) => void trailing.push(fire),
    })

    for (let attempt = 1; attempt <= 20; attempt += 1) recorder.record(record(attempt))
    for (let flush = 0; flush < 10; flush += 1) await recorder.flush()

    // The failure mode is a flood by definition; the throttle is what keeps the log readable.
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1)
    expect(lines.filter((line) => line.level === "error")).toHaveLength(1)
  })

  test("a burst that stops mid-window still reports its tail — the trailing count", async () => {
    // Before the trailing report, a burst of N sheds that went quiet was remembered as the one
    // event that opened the window: `dropped: 1`, forever.
    let clock = 1_000
    const trailing: (() => void)[] = []
    const { lines, recorder } = harness(() => new Error("unused"), {
      now: () => clock,
      timer: (fire) => void trailing.push(fire),
      queueMax: 1,
    })

    for (let burst = 0; burst < 500; burst += 1) recorder.record(record(burst))

    // 499 sheds (queueMax 1): the first spoke immediately, the rest armed one trailing timer.
    expect(lines.filter((line) => line.msg.includes("dropped"))).toMatchObject([{ dropped: 1 }])
    expect(trailing).toHaveLength(1)

    clock += 60_000
    trailing[0]?.()

    const drops = lines.filter((line) => line.msg.includes("dropped"))
    expect(drops).toHaveLength(2)
    expect(drops[1]?.dropped).toBe(498)
  })

  test("records still unwritten when the bounded drain ends are reported at error", async () => {
    const { lines, recorder } = harness(() => new Error("database is down"))

    for (let attempt = 1; attempt <= 6; attempt += 1) recorder.record(record(attempt))
    await recorder.stop()

    // The bounded passes ended without acknowledgement; report the unresolved records.
    const abandoned = lines.find((line) => line.msg.includes("unwritten when shutdown drain ended"))
    expect(abandoned).toMatchObject({ level: "error" })
    expect(abandoned?.records ?? 0).toBeGreaterThan(0)
  })
})

test("production admission duration observes success, retry and terminal-only batches, excluding markUsed", async () => {
  const metrics = createMetrics()
  let elapsed = 0,
    attempts = 0,
    marked = 0
  const observed: number[] = []
  const recorder = createUsageRecorderFromEnv({
    env: ENV,
    logger: createLogger({ level: "error", write: () => {} }),
    elapsed: () => elapsed,
    onAdmissionDuration: (duration) => {
      observed.push(duration)
      metrics.observeUsageAdmission(duration)
    },
    records: {
      insertBatch: async (input) => {
        attempts++
        elapsed += attempts === 1 ? 25 : 50
        if (attempts === 1) throw new Error("retry")
        return {
          insertedAttempts: input.attempts.length,
          insertedTerminals: input.terminals.length,
        }
      },
    },
    accounts: {
      markUsed: async () => {
        marked++
        elapsed += 1000
      },
    },
  })
  recorder.record(record(1))
  await recorder.flush()
  await recorder.flush()
  const event = record(2)
  recorder.recordTerminal({
    correlationId: event.correlationId,
    winnerEventId: event.eventId,
    apiKeyId: event.apiKeyId,
    accountId: event.accountId,
    poolId: event.poolId,
    provider: event.provider,
    model: event.model,
    upstreamModel: event.upstreamModel,
    outcome: event.outcome,
    errorClass: null,
    responseStatus: 200,
    httpStatus: 200,
    startedAt: AT,
    settledAt: AT,
    attributionKind: "winning-attempt",
  })
  await recorder.flush()
  expect(observed).toEqual([25, 50, 50])
  expect(marked).toBe(1)
  const exposed = metrics.expose()
  expect(exposed).toContain("router_usage_admission_seconds_count 3")
  expect(exposed).toContain("router_usage_admission_seconds_sum 0.125")
})

test("throwing admission observer cannot cause a committed write to be retried", async () => {
  let writes = 0
  const recorder = createUsageRecorderFromEnv({
    env: ENV,
    logger: createLogger({ level: "error", write: () => {} }),
    elapsed: () => 10,
    onAdmissionDuration: () => {
      throw new Error("metric unavailable")
    },
    records: {
      insertBatch: async (input) => {
        writes++
        return {
          insertedAttempts: input.attempts.length,
          insertedTerminals: input.terminals.length,
        }
      },
    },
    accounts: { markUsed: async () => {} },
  })
  recorder.record(record(1))
  await recorder.flush()
  await recorder.flush()
  expect(writes).toBe(1)
  expect(recorder.stats().writeFailures).toBe(0)
})

describe("a database outage is told apart from an unwritable batch (07.4)", () => {
  const coded = (code: string): Error => Object.assign(new Error(code), { code })

  test("connection, shutdown, resource and concurrency codes are transient, through the cause chain", () => {
    for (const code of [
      "ENOTFOUND",
      "ECONNREFUSED",
      "CONNECTION_CLOSED",
      "08006",
      "57P01",
      "53300",
      "40001",
      "40P01",
    ])
      expect(
        isTransientDatabaseError(new Error("Failed query: insert …", { cause: coded(code) })),
      ).toBe(true)
  })

  test("a constraint or a malformed row is not", () => {
    for (const code of ["23505", "22P02", "42703"])
      expect(isTransientDatabaseError(coded(code))).toBe(false)
    expect(isTransientDatabaseError(new Error("UsageIdentityConflict"))).toBe(false)
    expect(isTransientDatabaseError("boom")).toBe(false)
  })

  test("the 2026-10-31 restart keeps every record and drops nothing", async () => {
    let down = 5
    const inserted: number[] = []
    const lines: Line[] = []
    const recorder = createUsageRecorderFromEnv({
      records: {
        insertBatch: (admission) => {
          if (down > 0) {
            down -= 1
            return Promise.reject(
              new Error("Failed query: insert into usage_records …", {
                cause: coded("ENOTFOUND"),
              }),
            )
          }
          for (const row of admission.attempts) inserted.push(row.attempt ?? 0)
          return Promise.resolve({
            insertedAttempts: admission.attempts.length,
            insertedTerminals: admission.terminals.length,
          })
        },
      },
      accounts: { markUsed: () => Promise.resolve() },
      env: ENV,
      logger: createLogger({
        level: "debug",
        write: (line) => void lines.push(JSON.parse(line) as Line),
      }),
    })
    for (let attempt = 1; attempt <= 6; attempt += 1) recorder.record(record(attempt))
    for (let flush = 0; flush < 10; flush += 1) await recorder.flush()
    expect(inserted.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(recorder.stats()).toMatchObject({ depth: 0, writeDiscarded: 0 })
    expect(lines.some((line) => line.level === "error")).toBe(false)
  })

  test("a full retry buffer drops its oldest at error", async () => {
    const lines: Line[] = []
    const recorder = createUsageRecorderFromEnv({
      records: { insertBatch: () => Promise.reject(coded("ECONNREFUSED")) },
      accounts: { markUsed: () => Promise.resolve() },
      env: { ...ENV, usageRetryBufferMax: 2 },
      logger: createLogger({
        level: "debug",
        write: (line) => void lines.push(JSON.parse(line) as Line),
      }),
    })
    for (let attempt = 1; attempt <= 4; attempt += 1) recorder.record(record(attempt))
    await recorder.flush()
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "usage retry buffer full during a database outage — oldest records dropped",
        records: 2,
      }),
    )
    expect(recorder.stats()).toMatchObject({ writeDiscarded: 2, depth: 2 })
  })
})
