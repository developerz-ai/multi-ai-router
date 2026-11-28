import { describe, expect, test } from "bun:test"
import { createMetrics } from "../../../src/observability/metrics"
import { createHealthStore } from "../../../src/services/dataplane/health"
import { attemptRecord } from "../../../src/services/dataplane/records"
import { createRuntime } from "../../../src/services/dataplane/runtime"
import type { UsageRecord } from "../../../src/services/usage"
import { cipher, clock } from "../dataplane/fixtures"

/**
 * `router_upstream_ttfb_seconds`: how long the account took to send its first byte, by the model
 * it was sent, so a slow first token reads as the vendor's or the router's. `ttfbMs` on the row is
 * measured from the request entering the router (every failover, the selection and any recovery
 * wait before the byte), so it cannot tell them apart; the series is fed the attempt's own span.
 */

const STARTED = new Date("2026-11-28T10:00:00.000Z")
const SERIES = "router_upstream_ttfb_seconds"

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    eventId: crypto.randomUUID(),
    correlationId: "corr-1",
    clientRequestId: null,
    attempt: 2,
    apiKeyId: "key-1",
    accountId: "acct-1",
    poolId: "pool-1",
    provider: "openai-oauth",
    sessionKey: null,
    model: "codex-alias",
    upstreamModel: "gpt-5.6-terra",
    ingressDialect: "openai-responses",
    egressMode: "passthrough",
    tokensIn: 10,
    tokensOut: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    costEstimate: null,
    costBasis: "notional",
    latencyMs: 4_000,
    ttfbMs: 2_900,
    attemptTtfbMs: 1_400,
    routerOverheadMs: 2,
    outcome: "success",
    streamed: true,
    httpStatus: 200,
    responseStatus: 200,
    errorClass: null,
    startedAt: STARTED,
    finishedAt: new Date(STARTED.getTime() + 4_000),
    ...overrides,
  }
}

function samples(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith(`${SERIES}_`))
}

describe(SERIES, () => {
  test("observes the attempt's own first byte, labelled by provider and the model sent", () => {
    const metrics = createMetrics()
    metrics.observeUsage(record())
    const body = metrics.expose()
    expect(body).toContain(`${SERIES}_count{provider="openai-oauth",model="gpt-5.6-terra"} 1`)
    // 1.4 s, the attempt's span — not the 2.9 s the client waited through an earlier failover.
    expect(body).toContain(`${SERIES}_sum{provider="openai-oauth",model="gpt-5.6-terra"} 1.4`)
    expect(body).toContain(
      `${SERIES}_bucket{provider="openai-oauth",model="gpt-5.6-terra",le="1"} 0`,
    )
    expect(body).toContain(
      `${SERIES}_bucket{provider="openai-oauth",model="gpt-5.6-terra",le="2"} 1`,
    )
  })

  test("only an account that served gets a sample, so a client's typo mints no series", () => {
    const metrics = createMetrics()
    metrics.observeUsage(record({ outcome: "upstream_error", upstreamModel: "typo-model" }))
    metrics.observeUsage(record({ attemptTtfbMs: null, upstreamModel: "no-byte" }))
    metrics.observeUsage(record({ attemptTtfbMs: undefined, upstreamModel: "older-producer" }))
    metrics.observeUsage(record({ provider: null, accountId: null }))
    expect(samples(metrics.expose())).toEqual([])
  })

  test("the attempt span is first byte minus attempt start, kept apart from the row's ttfbMs", () => {
    const runtime = createRuntime({
      health: createHealthStore({ jitter: () => 0 }),
      cipher: cipher(),
      call: async () => new Response(null),
      sessionKeySource: "fingerprint",
      clock: clock(),
      timeoutMs: 30_000,
      record: () => {},
      correlationId: crypto.randomUUID(),
      clientRequestId: null,
      apiKeyId: "key-1",
      sessionKey: "session",
      model: "gpt-5.6-terra",
      ingressDialect: "openai-responses",
      operation: "messages",
      requestStarted: 100,
    })
    const timing = runtime.timing(STARTED, 1_600, 1_500, 3_000.4)
    expect(timing).toMatchObject({ ttfbMs: 2_900.4, attemptTtfbMs: 1_400.4 })
    const base = {
      correlationId: "corr-1",
      attempt: 2,
      apiKeyId: "key-1",
      accountId: "acct-1",
      provider: "openai-oauth",
      sessionKey: "session",
      model: "gpt-5.6-terra",
      upstreamModel: "gpt-5.6-terra",
      outcome: "success",
      streamed: true,
      httpStatus: 200,
      errorClass: null,
    } as const
    expect(attemptRecord({ ...base, timing })).toMatchObject({
      ttfbMs: 2_900,
      attemptTtfbMs: 1_400,
    })
    const unmeasured = runtime.timing(STARTED, 1_600, 1_500)
    expect(attemptRecord({ ...base, timing: unmeasured }).attemptTtfbMs).toBeNull()
  })
})
