import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

for (const protocolErrorFirst of [false, true]) {
  test(`caller abort settles without hung source cancellation; prior protocol error=${protocolErrorFirst}`, async () => {
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const routing = catalog([account("offline")]),
      health = createHealthStore({ jitter: () => 0 })
    const rows: UsageRecord[] = [],
      finishes: string[] = []
    const abort = new AbortController()
    let cancellations = 0,
      ends = 0,
      started = false
    const payload =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n' +
      (protocolErrorFirst
        ? 'data: {"type":"error","error":{"type":"api_error","message":"offline"}}\n\n'
        : "")
    const dispatcher = createDispatcher({
      activeRequests: registry,
      catalog: routing,
      cipher: cipher(),
      health: {
        ...health,
        endAttempt: (...args) => {
          ends++
          health.endAttempt(...args)
        },
      },
      usage: {
        record: (row) => {
          rows.push(row)
        },
      },
      recovery: {
        catalog: routing,
        retryAfterMs: 1000,
        quotaStaleAfterMs: 1000,
        currentSnapshot: () => routing.accounts()[0]?.snapshot,
        hint: () => {},
        forget: () => {},
        prepare: () => ({
          designated: true,
          started: () => started,
          beforeUpstreamStart: () => {
            started = true
          },
          finish: (state) => {
            finishes.push(state)
          },
        }),
      },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(payload))
            },
            cancel() {
              cancellations++
              return new Promise<void>(() => {})
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const response = await dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: ["offline"] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        signal: abort.signal,
        body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "offline" }] }),
      }),
    })
    if (!response.body) throw new Error("missing response body")
    const reader = response.body.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(payload)
    abort.abort()
    // Settlement is synchronous at abort observation, not deferred until cancellation resolves.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tokensIn: 7,
      httpStatus: 200,
      responseStatus: 200,
      outcome: protocolErrorFirst ? "upstream_error" : "client_error",
      errorClass: protocolErrorFirst ? "upstream_protocol_error" : "client_cancelled",
    })
    expect(health.stateOf("offline").inFlight).toBe(0)
    expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(protocolErrorFirst ? 1 : 0)
    expect(ends).toBe(1)
    expect(finishes).toEqual([protocolErrorFirst ? "failed" : "uncertain"])
    expect(registry.size).toBe(0)
    const next = registry.register()
    expect(next).toBeDefined()
    next?.release()
    await Bun.sleep(0)
    expect(cancellations).toBe(1)
    await registry.stop()
    expect(rows).toHaveLength(1)
    expect(ends).toBe(1)
    reader.releaseLock()
  })
}
