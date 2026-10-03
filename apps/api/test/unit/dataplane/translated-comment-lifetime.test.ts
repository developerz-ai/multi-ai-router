import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

for (const shutdown of [false, true]) {
  test(`translated comment-only response records actual wire bytes on ${shutdown ? "shutdown" : "caller cancellation"}`, async () => {
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const health = createHealthStore(),
      rows: UsageRecord[] = []
    const abort = new AbortController()
    let ends = 0
    const dispatcher = createDispatcher({
      activeRequests: registry,
      catalog: catalog([account("offline")]),
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
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"))
            },
            cancel() {
              return new Promise<void>(() => {})
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const response = await dispatcher.dispatch({
      ingress: "openai-chat",
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
      request: new Request("http://router.test/v1/chat/completions", {
        method: "POST",
        signal: abort.signal,
        body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "offline" }] }),
      }),
    })
    if (!response.body) throw new Error("missing response body")
    const reader = response.body.getReader()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toBe(": heartbeat\n\n")
    if (shutdown) await registry.stop()
    else abort.abort()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: "offline",
      model: "claude",
      upstreamModel: "claude",
      egressMode: "translate",
      httpStatus: 200,
      responseStatus: 200,
      streamed: true,
      ttfbMs: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outcome: shutdown ? "router_error" : "client_error",
      errorClass: shutdown ? "router_shutdown" : "client_cancelled",
    })
    expect(health.stateOf("offline").inFlight).toBe(0)
    expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
    expect(registry.size).toBe(0)
    expect(ends).toBe(1)
    await registry.stop()
    expect(rows).toHaveLength(1)
    reader.releaseLock()
  })
}
