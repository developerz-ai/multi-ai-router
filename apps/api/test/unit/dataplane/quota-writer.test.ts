import { describe, expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import type { QuotaWindowRow } from "@multi-ai-router/db"
import { createLogger, type Logger } from "../../../src/logging/logger"
import { createQuotaWindowWriter } from "../../../src/services/dataplane"
import { NOW } from "./fixtures"

/**
 * The durable half of quota state.
 *
 * `quota_windows` had exactly one writer before this and it only ever *cleared* expired rows, so
 * every gauge, countdown, and `quota-window-spent` verdict on a freshly booted replica read from an
 * empty table. What matters here is that making them durable costs a request nothing: the record is
 * a map write, the insert happens on the timer, and a database that refuses the row loses a row
 * rather than a request.
 */

/** The real logger with a capturing sink — the line an operator would read, redaction included. */
function logger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  return {
    logger: createLogger({
      level: "warn",
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    lines,
  }
}

function window(overrides: Partial<QuotaWindowState> = {}): QuotaWindowState {
  return {
    window: "five_hour",
    utilization: 0.8,
    utilizationSource: "threshold-triggered",
    resetsAt: new Date(NOW.getTime() + 3_600_000),
    resetSource: "provider-reported",
    lastCheckedAt: NOW,
    ...overrides,
  }
}

interface Upsert {
  readonly accountId: string
  readonly state: QuotaWindowState
}

function repository(failAll = false) {
  const upserts: Upsert[] = []
  return {
    upserts,
    upsertQuotaWindow: async (accountId: string, state: QuotaWindowState) => {
      if (failAll) throw new Error("connection refused")
      upserts.push({ accountId, state })
      return {} as QuotaWindowRow
    },
  }
}

describe("quota window writer", () => {
  test("writes one row per window on flush", async () => {
    const accounts = repository()
    const writer = createQuotaWindowWriter({
      accounts,
      logger: logger().logger,
      flushIntervalMs: 1_000,
    })

    writer.record("a", [window(), window({ window: "seven_day", utilization: 0.2 })])
    await writer.flush()

    expect(accounts.upserts.map((entry) => entry.state.window)).toEqual(["five_hour", "seven_day"])
    expect(accounts.upserts[0]?.accountId).toBe("a")
  })

  test("records nothing on the request path — the insert waits for the flush", async () => {
    const accounts = repository()
    const writer = createQuotaWindowWriter({
      accounts,
      logger: logger().logger,
      flushIntervalMs: 1_000,
    })

    writer.record("a", [window()])
    expect(accounts.upserts).toHaveLength(0)
    expect(writer.stats().pending).toBe(1)

    await writer.flush()
    expect(writer.stats()).toMatchObject({ pending: 0, written: 1 })
  })

  test("coalesces: a quota window is state, so the newest reading supersedes the older", () => {
    // The reason this is a map and `usage/recorder.ts` is a bounded queue. A usage record is a fact
    // about the past and losing one loses history; an older utilization is simply wrong now.
    const writer = createQuotaWindowWriter({
      accounts: repository(),
      logger: logger().logger,
      flushIntervalMs: 1_000,
    })

    for (let index = 0; index < 100; index += 1) writer.record("a", [window()])
    expect(writer.stats().pending).toBe(1)
  })

  test("a reading that arrives mid-flush belongs to the next one, not to the clear", async () => {
    const accounts = repository()
    const writer = createQuotaWindowWriter({
      accounts,
      logger: logger().logger,
      flushIntervalMs: 1_000,
    })

    writer.record("a", [window()])
    const flushing = writer.flush()
    writer.record("b", [window({ window: "seven_day" })])
    await flushing

    expect(writer.stats().pending).toBe(1)
    await writer.flush()
    expect(accounts.upserts.map((entry) => entry.accountId)).toEqual(["a", "b"])
  })

  test("a failed write loses the row, never the request — one line, whatever the batch", async () => {
    const sink = logger()
    const writer = createQuotaWindowWriter({
      accounts: repository(true),
      logger: sink.logger,
      flushIntervalMs: 1_000,
    })

    writer.record("a", [window(), window({ window: "seven_day" })])
    writer.record("b", [window()])
    await writer.flush()

    expect(writer.stats()).toMatchObject({ pending: 0, written: 0, writeFailures: 3 })
    expect(sink.lines).toHaveLength(1)
    expect(sink.lines[0]).toMatchObject({
      component: "quota",
      accounts: 2,
      reason: "connection refused",
    })
  })

  test("stop flushes what is left, so a clean shutdown loses no reading", async () => {
    const accounts = repository()
    const writer = createQuotaWindowWriter({
      accounts,
      logger: logger().logger,
      flushIntervalMs: 1_000,
    })

    writer.start()
    writer.record("a", [window()])
    await writer.stop()

    expect(accounts.upserts).toHaveLength(1)
  })

  test("an empty reading is not a claim, and writes nothing", async () => {
    const accounts = repository()
    const writer = createQuotaWindowWriter({
      accounts,
      logger: logger().logger,
      flushIntervalMs: 1_000,
    })

    writer.record("a", [])
    await writer.flush()

    expect(accounts.upserts).toHaveLength(0)
  })
})
