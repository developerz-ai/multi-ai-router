import { expect, test } from "bun:test"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { catalog, cipher, subscriptionAccount } from "./fixtures"

for (const late of ["started", "preparation", "deadline"] as const) {
  test(`SDK ${late} cancellation attributes the first abort cause`, async () => {
    const entered = Promise.withResolvers<void>()
    const upstream = Promise.withResolvers<Response>()
    const controller = new AbortController()
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const health = createHealthStore()
    const rows: UsageRecord[] = []
    let starts = 0
    const dispatcher = createDispatcher({
      activeRequests: registry,
      catalog: catalog([subscriptionAccount("offline")]),
      cipher: cipher(),
      health,
      usage: { record: (row) => void rows.push(row) },
      options: { upstreamTimeoutMs: late === "deadline" ? 5 : 1000 },
      invokeSdk: async (input) => {
        if (late !== "preparation") {
          input.beforeUpstreamStart?.()
          input.onUpstreamStarted?.()
          starts++
        }
        if (late === "deadline") {
          await new Promise<void>((resolve) =>
            input.signal?.addEventListener("abort", () => resolve(), { once: true }),
          )
        }
        entered.resolve()
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
    expect(health.stateOf("offline").inFlight).toBe(late === "preparation" ? 0 : 1)
    controller.abort(new Error("offline caller disconnected"))
    upstream.reject(new DOMException("SDK wrapped cancellation", "AbortError"))
    const result = await pending.then(
      (response) => response,
      (error: unknown) => error,
    )
    expect(
      result instanceof Response ? result.status : toErrorResponse(result, "anthropic").status,
    ).toBe(late === "deadline" ? 504 : 499)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      accountId: late === "preparation" ? null : "offline",
      httpStatus: null,
      responseStatus: late === "deadline" ? 504 : 499,
      outcome: late === "deadline" ? "upstream_timeout" : "client_error",
      errorClass: late === "deadline" ? null : "client_cancelled",
    })
    expect(starts).toBe(late === "preparation" ? 0 : 1)
    expect(registry.size).toBe(0)
    expect(health.stateOf("offline").inFlight).toBe(0)
    expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(late === "deadline" ? 1 : 0)
    const captured = structuredClone(rows[0])
    await registry.stop()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(captured)
  })
}
