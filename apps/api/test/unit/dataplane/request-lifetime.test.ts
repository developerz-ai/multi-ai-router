import { expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker } from "../../../src/providers"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher, subscriptionAccount } from "./fixtures"

const payload = JSON.stringify({
  model: "claude",
  max_tokens: 1,
  messages: [{ role: "user", content: "offline" }],
})
const callerId = "11111111-1111-4111-8111-111111111111"
function fixture(fetch: (request: Request) => Promise<Response>) {
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const rows: UsageRecord[] = []
  const health = createHealthStore()
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
    fetch,
  })
  const dispatch = (body: string | ReadableStream<Uint8Array> = payload, id = callerId) =>
    dispatcher.dispatch({
      ingress: "anthropic",
      requestId: id,
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: ["offline"] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", { method: "POST", body }),
    })
  return { registry, rows, health, dispatch, ends: () => ends }
}
test("full request registry refuses before reading upload or fetching and records one null-account503", async () => {
  let fetches = 0,
    reads = 0
  const f = fixture(async () => {
    fetches++
    return new Response("{}")
  })
  const occupied = f.registry.register()
  if (!occupied) throw new Error("fixture registry did not admit initial lease")
  const body = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        reads++
      },
    },
    { highWaterMark: 0 },
  )
  try {
    await expect(f.dispatch(body)).rejects.toMatchObject({
      name: "RequestAdmissionUnavailableError",
    })
    expect({ fetches, reads }).toEqual({ fetches: 0, reads: 0 })
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({
      accountId: null,
      responseStatus: 503,
      httpStatus: null,
      outcome: "router_error",
      errorClass: "request_admission_unavailable",
      model: null,
    })
    expect(f.ends()).toBe(0)
  } finally {
    occupied.release()
    await body.cancel()
  }
})
test("shutdown during held upload records one pre-start router_shutdown503 and no selected account", async () => {
  const entered = Promise.withResolvers<void>()
  let fetches = 0
  const f = fixture(async () => {
    fetches++
    return new Response("{}")
  })
  const body = new ReadableStream<Uint8Array>(
    {
      pull: () => {
        entered.resolve()
      },
    },
    { highWaterMark: 0 },
  )
  const pending = f.dispatch(body).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
  await entered.promise
  expect(f.registry.size).toBe(1)
  await f.registry.stop()
  expect((await pending).error).toMatchObject({ name: "RouterShutdownError" })
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]).toMatchObject({
    accountId: null,
    responseStatus: 503,
    httpStatus: null,
    outcome: "router_error",
    errorClass: "router_shutdown",
    model: null,
  })
  expect(fetches).toBe(0)
  expect(f.ends()).toBe(0)
  expect(f.registry.size).toBe(0)
})
for (const late of ["response", "failure"] as const) {
  test(`shutdown awaiting HTTP headers records selected account once; late ${late} adds no event or decrement`, async () => {
    const entered = Promise.withResolvers<void>()
    const upstream = Promise.withResolvers<Response>()
    const f = fixture(async () => {
      entered.resolve()
      return upstream.promise
    })
    const pending = f.dispatch().then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    await entered.promise
    expect(f.health.stateOf("offline").inFlight).toBe(1)
    await f.registry.stop()
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({
      accountId: "offline",
      responseStatus: null,
      httpStatus: null,
      outcome: "router_error",
      errorClass: "router_shutdown",
      model: "claude",
    })
    expect(f.ends()).toBe(1)
    expect(f.health.stateOf("offline").inFlight).toBe(0)
    const captured = structuredClone(f.rows[0])
    let canceled = 0
    if (late === "response")
      upstream.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled++
              // Best-effort cleanup must not await an uncooperative upstream cancellation.
              return new Promise<void>(() => {})
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
    else upstream.reject(new Error("offline late read failure"))
    expect((await pending).error).toMatchObject({ name: "RouterShutdownError" })
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toEqual(captured)
    expect(canceled).toBe(late === "response" ? 1 : 0)
    expect(f.ends()).toBe(1)
    expect(f.health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
    expect(f.registry.size).toBe(0)
  })
}
test("same caller UUID remains trace metadata while distinct refused requests get independent identities", async () => {
  const f = fixture(async () => {
    throw new Error("must not fetch")
  })
  const occupied = f.registry.register()
  if (!occupied) throw new Error("fixture registry did not admit initial lease")
  try {
    for (let i = 0; i < 2; i++)
      await expect(f.dispatch()).rejects.toMatchObject({ name: "RequestAdmissionUnavailableError" })
    expect(f.rows).toHaveLength(2)
    expect(f.rows[0]?.clientRequestId).toBe(callerId)
    expect(f.rows[1]?.clientRequestId).toBe(callerId)
    expect(f.rows[0]?.correlationId).not.toBe(f.rows[1]?.correlationId)
    expect(f.rows[0]?.eventId).not.toBe(f.rows[1]?.eventId)
  } finally {
    occupied.release()
  }
})

test("shutdown during SDK guardian preparation retains no health inFlight or fictional selected account", async () => {
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const rows: UsageRecord[] = []
  const health = createHealthStore()
  const ready = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
  let activated = 0,
    pulls = 0
  const invokeSdk = createSdkInvoker({
    concurrency,
    resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1000 }),
    ownerLaunch: () => ({
      ready: ready.promise,
      started: Promise.resolve(),
      exited: Promise.resolve(),
      prepare: async () => {},
      assertReady: () => {},
      activate: () => {
        activated++
      },
      cancel: () => {},
      release: () => {},
      spawn: () => {
        throw new Error("must not launch a real CLI")
      },
    }),
    runQuery: () => {
      entered.resolve()
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            pulls++
            throw new Error("must not pull unstarted query")
          },
        }),
      }
    },
  })
  const dispatcher = createDispatcher({
    activeRequests: registry,
    catalog: catalog([subscriptionAccount("offline")]),
    cipher: cipher(),
    health,
    invokeSdk,
    fetch: async () => {
      throw new Error("must not fetch SDK request")
    },
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
  })
  const pending = dispatcher
    .dispatch({
      ingress: "anthropic",
      requestId: callerId,
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: ["offline"] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", { method: "POST", body: payload }),
    })
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
  await entered.promise
  expect(health.stateOf("offline").inFlight).toBe(0)
  await registry.stop()
  expect(health.stateOf("offline").inFlight).toBe(0)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    accountId: null,
    responseStatus: 503,
    outcome: "router_error",
    errorClass: "router_shutdown",
  })
  ready.resolve()
  expect((await pending).error).toMatchObject({ name: "RouterShutdownError" })
  expect(rows).toHaveLength(1)
  expect({ activated, pulls }).toEqual({ activated: 0, pulls: 0 })
  expect(health.stateOf("offline").inFlight).toBe(0)
  expect(health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
  expect(concurrency.inFlight).toBe(0)
})
