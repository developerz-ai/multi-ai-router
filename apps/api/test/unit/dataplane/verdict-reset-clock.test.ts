import { expect, test } from "bun:test"
import { QuotaExhaustedError } from "@multi-ai-router/core"
import { createHealthStore, planCandidates } from "../../../src/services/dataplane"
import { type ChainContext, runChain } from "../../../src/services/dataplane/chain"
import { createRuntime } from "../../../src/services/dataplane/runtime"
import type { UsageRecord } from "../../../src/services/usage"
import { candidate } from "../routing/fixtures"
import { account, catalog, cipher, clock, NOW } from "./fixtures"

function fixture(status: number, headers: Record<string, string>, unknownRetry = 30) {
  const upstream = account("a", { provider: "openai-api" })
  const plan = planCandidates(
    [candidate(upstream.snapshot)],
    catalog([upstream]),
    "openai-chat",
    "messages",
  )
  const time = clock()
  const health = createHealthStore({ jitter: () => 0 })
  const rows: UsageRecord[] = []
  const body = new TextEncoder().encode(JSON.stringify({ model: "fixture", messages: [] }))
  const runtime = createRuntime({
    health,
    cipher: cipher(),
    call: async () => {
      time.advance(300000)
      return new Response(
        status === 200
          ? "{}"
          : JSON.stringify({ error: { message: "temporary fixture throttle" } }),
        { status, headers },
      )
    },
    sessionKeySource: "fingerprint",
    clock: time,
    timeoutMs: 1000,
    record: (row) => {
      rows.push(row)
    },
    correlationId: crypto.randomUUID(),
    clientRequestId: null,
    apiKeyId: crypto.randomUUID(),
    sessionKey: "fixture",
    model: "fixture",
    ingressDialect: "openai-chat",
    operation: "messages",
    requestStarted: 0,
    unknownResetRetryAfterSeconds: unknownRetry,
  })
  const context: ChainContext = {
    runtime,
    plan: plan.servable,
    request: new Request("http://router.test", { method: "POST" }),
    bodyBytes: body,
    modelSpan: null,
    translation: { created: 0, model: "fixture", fallbackId: "test" },
    translated: { bodyFor: () => body },
    failover: undefined,
    log: undefined,
  }
  return { context, health, rows, time }
}

for (const status of [200, 429]) {
  test(`${status} delayed upstream starts relative six-minute cooldown at response verdict`, async () => {
    const f = fixture(status, {
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "6m0s",
    })
    if (status === 200) await (await runChain(f.context)).text()
    else {
      try {
        await runChain(f.context)
        throw new Error("expected throttle")
      } catch (error) {
        if (!(error instanceof QuotaExhaustedError)) throw error
        expect(error.retryAfterSeconds).toBe(360)
        expect(error.resetsAt).toEqual(new Date(NOW.getTime() + 660000))
      }
    }
    expect(f.health.stateOf("a").breaker.cooldownUntil).toEqual(new Date(NOW.getTime() + 660000))
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]?.startedAt).toEqual(NOW)
  })
}

test("elapsed absolute reset never shortens relative cooldown after slow upstream", async () => {
  const f = fixture(429, {
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": String(NOW.getTime() + 10000),
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-reset-tokens": "6m",
  })
  try {
    await runChain(f.context)
    throw new Error("expected throttle")
  } catch (error) {
    if (!(error instanceof QuotaExhaustedError)) throw error
    expect(error.retryAfterSeconds).toBe(360)
    expect(error.resetsAt).toEqual(f.health.stateOf("a").breaker.cooldownUntil)
  }
})

test("unknown reset uses configured retry hint without fabricating provider reset", async () => {
  const f = fixture(429, {}, 17)
  try {
    await runChain(f.context)
    throw new Error("expected throttle")
  } catch (error) {
    if (!(error instanceof QuotaExhaustedError)) throw error
    expect(error.retryAfterSeconds).toBe(17)
    expect(error.resetsAt).toBeUndefined()
  }
  expect(f.health.stateOf("a").breaker.cooldownSource).toBe("estimated")
})
