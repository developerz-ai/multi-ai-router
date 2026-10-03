import { expect, test } from "bun:test"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

for (const status of [400, 429, 503]) {
  test(`received HTTP ${status} remains the provider verdict when its error body aborts the caller`, async () => {
    const caller = new AbortController()
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const health = createHealthStore()
    const rows: UsageRecord[] = []
    let reads = 0
    const dispatcher = createDispatcher({
      activeRequests: registry,
      catalog: catalog([account("offline")]),
      cipher: cipher(),
      health,
      usage: { record: (row) => rows.push(row) },
      options: { failover: { maxAttempts: 1 } },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                reads++
                caller.abort(
                  new Error("offline caller disconnected while reading the provider error"),
                )
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      type: "error",
                      error: {
                        type:
                          status === 400
                            ? "invalid_request_error"
                            : status === 429
                              ? "rate_limit_error"
                              : "api_error",
                        message: "offline",
                      },
                    }),
                  ),
                )
                controller.close()
              },
            },
            { highWaterMark: 0 },
          ),
          { status, headers: { "content-type": "application/json" } },
        ),
    })
    const response = await dispatcher
      .dispatch({
        ingress: "anthropic",
        requestId: "offline-provider-error",
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
          signal: caller.signal,
          body: JSON.stringify({
            model: "claude",
            max_tokens: 1,
            messages: [{ role: "user", content: "offline" }],
          }),
        }),
      })
      .catch((error) => toErrorResponse(error, "anthropic"))
    if (response instanceof Response) await response.text()
    expect(reads).toBe(1)
    expect(caller.signal.aborted).toBe(true)
    expect(response.status).toBe(status)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: "offline",
      httpStatus: status,
      responseStatus: status,
    })
    if (status === 400) {
      expect(rows[0]?.outcome).toBe("client_error")
      expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
      expect(health.stateOf("offline").breaker.status).toBe("active")
    }
    expect(rows[0]?.errorClass).not.toBe("client_cancelled")
    expect(health.stateOf("offline").inFlight).toBe(0)
    expect(registry.size).toBe(0)
    await registry.stop()
    expect(rows).toHaveLength(1)
  })
}
