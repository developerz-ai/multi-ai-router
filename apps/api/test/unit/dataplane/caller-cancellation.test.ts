import { expect, test } from "bun:test"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

test("caller abort during held upload renders499 and records one null-account cancellation without fetch", async () => {
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        entered.resolve()
      },
    },
    { highWaterMark: 0 },
  )
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const health = createHealthStore()
  const rows: UsageRecord[] = []
  const outcomes: string[] = []
  let fetches = 0
  const dispatcher = createDispatcher({
    activeRequests: registry,
    catalog: catalog([account("offline")]),
    cipher: cipher(),
    health,
    onRequest: (sample) => {
      outcomes.push(sample.outcome)
    },
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
    fetch: async () => {
      fetches++
      throw new Error("must not call upstream during upload")
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
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
  await entered.promise
  controller.abort(new Error("offline caller ended upload"))
  const result = await pending
  expect(result.value).toBeUndefined()
  expect(result.error).toMatchObject({ name: "ClientCancelledError" })
  expect(toErrorResponse(result.error, "anthropic").status).toBe(499)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    accountId: null,
    provider: null,
    httpStatus: null,
    responseStatus: 499,
    outcome: "client_error",
    errorClass: "client_cancelled",
    model: null,
  })
  expect(outcomes).toEqual(["client_error"])
  expect(fetches).toBe(0)
  expect(registry.size).toBe(0)
  expect(health.stateOf("offline").inFlight).toBe(0)
  expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
  await registry.stop()
  expect(rows).toHaveLength(1)
  expect(outcomes).toEqual(["client_error"])
})
