import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

for (const status of [401, 429, 503]) {
  test(`completed upstream ${status} releases capacity and shutdown never invents a second event`, async () => {
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const health = createHealthStore()
    const rows: UsageRecord[] = []
    let fetches = 0,
      ends = 0
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
      options: { failover: { maxAttempts: 1 } },
      fetch: async () => {
        fetches++
        return fetches === 1
          ? new Response('{"type":"error","error":{"type":"api_error","message":"offline"}}', {
              status,
              headers: { "content-type": "application/json" },
            })
          : new Response('{"usage":{"input_tokens":2,"output_tokens":1}}', {
              headers: { "content-type": "application/json" },
            })
      },
    })
    const dispatch = () =>
      dispatcher.dispatch({
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
        }),
      })
    const failed = await dispatch()
    expect(failed.status).toBe(status)
    await failed.text()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: "offline",
      httpStatus: status,
      responseStatus: status,
    })
    expect(registry.size).toBe(0)
    expect(ends).toBe(1)
    health.reset("offline")
    const next = await dispatch()
    expect(next.status).toBe(200)
    await next.text()
    expect(fetches).toBe(2)
    expect(rows).toHaveLength(2)
    expect(rows[1]?.outcome).toBe("success")
    expect(registry.size).toBe(0)
    expect(ends).toBe(2)
    await registry.stop()
    expect(rows).toHaveLength(2)
    expect(ends).toBe(2)
    expect(health.stateOf("offline").inFlight).toBe(0)
  })
}
