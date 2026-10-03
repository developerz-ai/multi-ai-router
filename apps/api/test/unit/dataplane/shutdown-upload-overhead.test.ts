import { expect, test } from "bun:test"
import { createDispatcher } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher, clock } from "./fixtures"

for (const cause of ["shutdown", "caller"] as const) {
  test(`${cause} during pending upload excludes unfinished reader wait from router overhead`, async () => {
    const timer = clock(new Date(0))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => entered.resolve(),
        cancel: () => {
          return release.promise
        },
      },
      { highWaterMark: 0 },
    )
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const rows: UsageRecord[] = []
    let fetches = 0
    const dispatcher = createDispatcher({
      activeRequests: registry,
      clock: timer,
      catalog: catalog([account("offline")]),
      cipher: cipher(),
      usage: { record: (row) => void rows.push(row) },
      fetch: async () => {
        fetches++
        throw new Error("held upload must not reach upstream")
      },
    })
    const pending = dispatcher
      .dispatch({
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
          body,
          signal: controller.signal,
        }),
      })
      .catch((error: unknown) => error)
    await entered.promise
    timer.advance(100)
    if (cause === "shutdown") await registry.stop()
    else controller.abort(new Error("caller stopped upload"))
    await pending
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: null,
      responseStatus: cause === "shutdown" ? 503 : 499,
      errorClass: cause === "shutdown" ? "router_shutdown" : "client_cancelled",
      latencyMs: 100,
      routerOverheadMs: 0,
    })
    expect(fetches).toBe(0)
    // Reader cancellation is still unsettled when the accounting snapshot above is taken.
    timer.advance(50)
    release.resolve()
    await Promise.resolve()
    await registry.stop()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.latencyMs).toBe(100)
    expect(rows[0]?.routerOverheadMs).toBe(0)
    expect(registry.size).toBe(0)
  })
}
