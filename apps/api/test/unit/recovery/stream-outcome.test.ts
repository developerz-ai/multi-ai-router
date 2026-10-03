import { expect, test } from "bun:test"
import { createHealthStore, planCandidates } from "../../../src/services/dataplane"
import { relaySuccess } from "../../../src/services/dataplane/chain-relay"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import { createRuntime } from "../../../src/services/dataplane/runtime"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher, clock, NOW, slowStream } from "../dataplane/fixtures"
import { candidate } from "../routing/fixtures"

function fixture(response: Response, signal?: AbortSignal) {
  const upstream = account("a")
  const plan = planCandidates(
    [candidate(upstream.snapshot)],
    catalog([upstream]),
    "anthropic",
    "messages",
  )
  const servable = plan.servable[0]
  if (servable === undefined) throw new Error("missing servable account")
  const health = createHealthStore({ jitter: () => 0 })
  const observation = health.captureAttempt("a", accountHealthFacts(upstream))
  health.beginAttempt("a")
  health.recordSuccess("a", observation)
  const states: string[] = []
  const rows: UsageRecord[] = []
  const runtime = createRuntime({
    health,
    cipher: cipher(),
    call: async () => response,
    sessionKeySource: "fingerprint",
    clock: clock(),
    timeoutMs: 30000,
    record: (row) => {
      rows.push(row)
    },
    correlationId: crypto.randomUUID(),
    clientRequestId: null,
    apiKeyId: crypto.randomUUID(),
    sessionKey: "session",
    model: "claude-opus-5",
    ingressDialect: "anthropic",
    operation: "messages",
    requestStarted: 0,
  })
  const relayed = relaySuccess(
    {
      runtime,
      translation: { created: 0, model: "claude-opus-5", fallbackId: "test" },
      log: undefined,
      request: new Request("http://router.test", { signal }),
    },
    servable,
    1,
    response,
    {
      startedAt: NOW,
      started: 0,
      upstreamMs: 0,
      upstreamStarted: 0,
      observation,
      recovery: {
        designated: true,
        started: () => true,
        finish: (state) => {
          states.push(state)
        },
      },
    },
  )
  return { relayed, states, health, rows }
}
test("designated stream succeeds only at clean settlement without buffering", async () => {
  const upstream = slowStream(["first", "second"])
  const f = fixture(upstream.response)
  if (f.relayed.body === null) throw new Error("missing body")
  const reader = f.relayed.body.getReader()
  upstream.release(0)
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first")
  expect(f.states).toEqual([])
  upstream.release(1)
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("second")
  upstream.finish()
  expect((await reader.read()).done).toBe(true)
  expect(f.states).toEqual(["succeeded"])
  expect(f.rows).toHaveLength(1)
})
test("designated stream failure below normal threshold retrips and records failure once", async () => {
  const f = fixture(
    new Response(
      new ReadableStream({ start: (controller) => controller.error(new Error("connection lost")) }),
    ),
  )
  await expect(f.relayed.text()).rejects.toThrow("connection lost")
  for (let i = 0; i < 20 && f.states.length === 0; i++) await Promise.resolve()
  expect(f.states).toEqual(["failed"])
  expect(f.health.stateOf("a").breaker.status).toBe("cooling_down")
  expect(f.rows).toHaveLength(1)
})
test("client stream cancellation records uncertainty without striking the account", async () => {
  const upstream = slowStream(["first"])
  const f = fixture(upstream.response)
  if (f.relayed.body === null) throw new Error("missing body")
  const reader = f.relayed.body.getReader()
  await reader.cancel()
  expect(f.states).toEqual(["uncertain"])
  expect(f.health.stateOf("a").breaker.status).toBe("active")
  expect(f.rows).toHaveLength(1)
})
