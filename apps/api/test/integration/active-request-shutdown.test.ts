import { expect, test } from "bun:test"
import { createRuntimeLifecycle } from "../../src/composition/lifecycle"
import { createLogger } from "../../src/logging/logger"
import { createActiveRequestRegistry } from "../../src/services/dataplane/active-requests"
import { drainServer } from "../../src/services/shutdown/drain"
import type { UsageRecord } from "../../src/services/usage/record"
import { createUsageRecorder } from "../../src/services/usage/recorder"

function abandonedEvent(): UsageRecord {
  const at = new Date()
  return {
    eventId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    clientRequestId: null,
    attempt: 1,
    apiKeyId: null,
    accountId: "upstream-fixture",
    poolId: null,
    provider: "anthropic-api",
    sessionKey: null,
    model: "fixture",
    upstreamModel: "fixture",
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    tokensIn: 4,
    tokensOut: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costEstimate: null,
    costBasis: "unknown",
    latencyMs: 1,
    ttfbMs: 1,
    routerOverheadMs: 0,
    outcome: "router_error",
    streamed: true,
    httpStatus: 200,
    responseStatus: 200,
    errorClass: "router_shutdown",
    startedAt: at,
    finishedAt: at,
  }
}
test("HTTP drain deadline settles held events before the real usage writer drains despite hung cancellation", async () => {
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const events: string[] = [],
    written: UsageRecord[] = []
  const usage = createUsageRecorder({
    write: async (batch) => {
      events.push("writer")
      written.push(...batch)
    },
  })
  const entered = Promise.withResolvers<void>()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const lease = registry.register()
      if (!lease) return new Response(null, { status: 503 })
      lease.setAbandon(() => {
        events.push("abandon")
        usage.record(abandonedEvent())
      })
      lease.signal.addEventListener("abort", () => {
        events.push("abort")
        void new Promise<void>(() => {})
      })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            controller.enqueue(new TextEncoder().encode("partial"))
            entered.resolve()
          },
        }),
      )
    },
  })
  const runtime = createRuntimeLifecycle({
    logger: createLogger({ level: "error", write: () => {} }),
    start: async () => {},
    phases: [
      [{ name: "admission", run: () => registry.closeAdmission() }],
      [{ name: "active-requests", run: () => registry.stop() }],
      [{ name: "usage-writer", run: () => usage.stop() }],
    ],
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`)
    await entered.promise
    const body = response.text()
    registry.closeAdmission()
    const drain = await drainServer({ server, timeoutMs: 5 })
    expect(drain.timedOut).toBe(true)
    expect(written).toHaveLength(0)
    await runtime.stop()
    expect(events).toEqual(["abandon", "abort", "writer"])
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      accountId: "upstream-fixture",
      tokensIn: 4,
      tokensOut: 2,
      outcome: "router_error",
      errorClass: "router_shutdown",
      responseStatus: 200,
    })
    expect(registry.size).toBe(0)
    stream?.close()
    expect(await body).toBe("partial")
  } finally {
    try {
      stream?.close()
    } catch {}
    await server.stop(true)
    await runtime.stop()
  }
})
