import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

const encoder = new TextEncoder()
const usage =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n'
const failure =
  'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"offline"}}\n\n'
async function fixture() {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined
  const rows: UsageRecord[] = []
  const health = createHealthStore({ jitter: () => 0 })
  const registry = createActiveRequestRegistry({ maximumEntries: 10 })
  const requestAbort = new AbortController()
  const routing = catalog([account("a")])
  const finished: string[] = []
  let started = false
  const dispatcher = createDispatcher({
    catalog: routing,
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
          finished.push(state)
        },
      }),
    },
    cipher: cipher(),
    health,
    activeRequests: registry,
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller
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
      scope: { kind: "accounts", accountIds: ["a"] },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/messages", {
      method: "POST",
      signal: requestAbort.signal,
      body: JSON.stringify({
        model: "claude",
        max_tokens: 1,
        messages: [{ role: "user", content: "offline" }],
      }),
    }),
  })
  if (source === undefined || response.body === null) throw new Error("missing stream")
  const reader = response.body.getReader()
  return { source, reader, response, rows, health, registry, requestAbort, finished }
}

test("explicit HTTP200 error remains provider failure after later caller cancellation", async () => {
  const f = await fixture()
  f.source.enqueue(encoder.encode(usage + failure))
  const chunk = await f.reader.read()
  expect(new TextDecoder().decode(chunk.value)).toBe(usage + failure)
  f.requestAbort.abort()
  await f.reader.read().catch(() => {})
  await Promise.resolve()
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]).toMatchObject({
    outcome: "upstream_error",
    errorClass: "upstream_protocol_error",
    tokensIn: 7,
    httpStatus: 200,
    responseStatus: 200,
  })
  expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(1)
  expect(f.registry.size).toBe(0)
  expect(f.finished).toEqual(["failed"])
})

test("caller cancellation observed first wins over later read failure without account strike", async () => {
  const f = await fixture()
  f.source.enqueue(encoder.encode(usage))
  await f.reader.read()
  f.requestAbort.abort()
  await f.reader.read().catch(() => {})
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]).toMatchObject({
    outcome: "client_error",
    errorClass: "client_cancelled",
    tokensIn: 7,
  })
  expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(0)
})

test("clean completion settles once and later abort cannot relabel success", async () => {
  const f = await fixture()
  const bytes = `${usage}event: message_stop\ndata: {"type":"message_stop"}\n\n`
  f.source.enqueue(encoder.encode(bytes))
  f.source.close()
  expect(new TextDecoder().decode((await f.reader.read()).value)).toBe(bytes)
  await f.reader.read()
  f.requestAbort.abort()
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]?.outcome).toBe("success")
  expect(f.finished).toEqual(["succeeded"])
})

test("shutdown settles partial counts before abort and releases the active lease", async () => {
  const f = await fixture()
  f.source.enqueue(encoder.encode(usage))
  await f.reader.read()
  await f.registry.stop()
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]).toMatchObject({
    outcome: "router_error",
    errorClass: "router_shutdown",
    tokensIn: 7,
  })
  expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(0)
  expect(f.health.stateOf("a").inFlight).toBe(0)
  expect(f.registry.size).toBe(0)
  await f.reader.read().catch(() => {})
  expect(f.rows).toHaveLength(1)
})

test("transport error settles before a later request abort", async () => {
  const f = await fixture()
  f.source.enqueue(encoder.encode(usage))
  await f.reader.read()
  f.source.error(new Error("offline socket failure"))
  await f.reader.read().catch(() => {})
  f.requestAbort.abort()
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]).toMatchObject({
    outcome: "upstream_error",
    errorClass: "upstream_error",
    tokensIn: 7,
  })
  expect(f.finished).toEqual(["failed"])
})

test("downstream reader cancellation is observed even without request abort", async () => {
  const f = await fixture()
  f.source.enqueue(encoder.encode(usage))
  await f.reader.read()
  await f.reader.cancel()
  expect(f.requestAbort.signal.aborted).toBe(false)
  expect(f.rows).toHaveLength(1)
  expect(f.rows[0]).toMatchObject({ outcome: "client_error", errorClass: "client_cancelled" })
  expect(f.finished).toEqual(["uncertain"])
  expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(0)
})
