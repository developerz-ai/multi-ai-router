import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

for (const late of ["response", "rejection"] as const) {
  test(`caller abort awaiting headers releases its lease despite late fetch ${late}`, async () => {
    const entered = Promise.withResolvers<void>()
    const upstream = Promise.withResolvers<Response>()
    const controller = new AbortController()
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const health = createHealthStore()
    const rows: UsageRecord[] = []
    let canceled = 0
    const dispatcher = createDispatcher({
      activeRequests: registry,
      catalog: catalog([account("offline")]),
      cipher: cipher(),
      health,
      usage: { record: (row) => void rows.push(row) },
      fetch: async () => {
        entered.resolve()
        // Deliberately ignore Request.signal: the dispatcher owns cancellation accounting.
        return upstream.promise
      },
    })
    const pending = dispatcher.dispatch({
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
        body: JSON.stringify({
          model: "claude",
          max_tokens: 1,
          messages: [{ role: "user", content: "offline" }],
        }),
        signal: controller.signal,
      }),
    })
    await entered.promise
    expect(health.stateOf("offline").inFlight).toBe(1)
    controller.abort(new Error("offline caller disconnected"))
    if (late === "response") {
      upstream.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled++
              return new Promise<void>(() => {})
            },
          }),
          { status: 200 },
        ),
      )
    } else upstream.reject(new Error("offline late transport rejection"))
    expect((await pending).status).toBe(499)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: "offline",
      httpStatus: late === "response" ? 200 : null,
      responseStatus: 499,
      outcome: "client_error",
      errorClass: "client_cancelled",
    })
    expect(canceled).toBe(late === "response" ? 1 : 0)
    expect(registry.size).toBe(0)
    expect(health.stateOf("offline").inFlight).toBe(0)
    expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
    const captured = structuredClone(rows[0])
    await registry.stop()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(captured)
  })
}
