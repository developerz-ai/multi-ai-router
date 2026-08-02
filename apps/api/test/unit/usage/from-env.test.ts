import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import type { UsageRecord } from "../../../src/services/usage"
import { createUsageRecorderFromEnv } from "../../../src/services/usage"

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
  dataPlane: { usageQueueMax: 100, usageBatchSize: 2, usageFlushIntervalMs: 1_000 },
}

function record(attempt: number): UsageRecord {
  return {
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
}

function harness(reject: () => Error) {
  const lines: Line[] = []
  const recorder = createUsageRecorderFromEnv({
    records: { insertMany: () => Promise.reject(reject()) },
    env: ENV,
    logger: createLogger({
      level: "debug",
      write: (line) => void lines.push(JSON.parse(line) as Line),
    }),
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

  test("says it once per window however many batches are refused", async () => {
    const { lines, recorder } = harness(() => new Error("database is down"))

    for (let attempt = 1; attempt <= 20; attempt += 1) recorder.record(record(attempt))
    for (let flush = 0; flush < 10; flush += 1) await recorder.flush()

    // The failure mode is a flood by definition; the throttle is what keeps the log readable.
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1)
    expect(lines.filter((line) => line.level === "error")).toHaveLength(1)
  })
})
