import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { RequestSample } from "../../../src/services/dataplane/types"
import type { UsageRecord, UsageRequestTerminal } from "../../../src/services/usage"
import { account, catalog, cipher, clock } from "./fixtures"

const pool = {
  id: "pool",
  name: "pool",
  policy: "round-robin" as const,
  members: [{ accountId: "a" }, { accountId: "b" }],
}
function input(signal?: AbortSignal) {
  return {
    ingress: "anthropic" as const,
    requestId: crypto.randomUUID(),
    key: {
      id: "key",
      name: "offline",
      prefix: "offline",
      scope: { kind: "pools" as const, poolIds: ["pool", "pool"] },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/messages", {
      method: "POST",
      signal,
      body: JSON.stringify({
        model: "claude",
        stream: true,
        max_tokens: 1,
        messages: [{ role: "user", content: "offline" }],
      }),
    }),
  }
}
for (const terminal of ["protocol", "transport", "caller", "shutdown"] as const) {
  test(`terminal request observer remains quiet at200 headers and reports ${terminal} exactly once`, async () => {
    const samples: RequestSample[] = []
    const rows: UsageRecord[] = []
    const facts: UsageRequestTerminal[] = []
    const timer = clock(new Date(0))
    const registry = createActiveRequestRegistry({ maximumEntries: 1 })
    const caller = new AbortController()
    const source = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const upstream = new ReadableStream<Uint8Array>({
      start: (controller) => source.resolve(controller),
    })
    const dispatcher = createDispatcher({
      health: createHealthStore(),
      activeRequests: registry,
      clock: timer,
      catalog: catalog([account("a"), account("b")], [pool]),
      cipher: cipher(),
      onRequest: (sample) => samples.push(sample),
      usage: {
        record: (row) => void rows.push(row),
        recordTerminal: (fact) => void facts.push(fact),
      },
      fetch: async () =>
        new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    })
    const response = await dispatcher.dispatch(input(caller.signal))
    expect(response.status).toBe(200)
    expect(samples).toHaveLength(0)
    const drained = response.text().catch(() => "cancelled")
    timer.advance(100)
    const stream = await source.promise
    if (terminal === "protocol") {
      stream.enqueue(
        new TextEncoder().encode(
          'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n',
        ),
      )
      stream.close()
    } else if (terminal === "transport") stream.error(new Error("offline stream failure"))
    else if (terminal === "caller") caller.abort(new Error("caller ended response"))
    else await registry.stop()
    await drained
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      outcome:
        terminal === "caller"
          ? "client_error"
          : terminal === "shutdown"
            ? "router_error"
            : "upstream_error",
      durationMs: 100,
      requestedPoolIds: ["pool"],
      servedPoolId: "pool",
      streamed: terminal === "protocol",
    })
    expect(rows).toHaveLength(1)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      winnerEventId: rows[0]?.eventId,
      accountId: rows[0]?.accountId,
      outcome: samples[0]?.outcome,
      responseStatus: 200,
      startedAt: new Date(0),
      settledAt: new Date(100),
      attributionKind:
        terminal === "caller" || terminal === "shutdown" ? "abandoned" : "winning-attempt",
    })
    await registry.stop()
    expect(samples).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(facts).toHaveLength(1)
  })
}
test("failed attempt followed by success produces one terminal demand sample for the served pool", async () => {
  const samples: RequestSample[] = []
  const rows: UsageRecord[] = []
  let calls = 0
  const dispatcher = createDispatcher({
    health: createHealthStore(),
    catalog: catalog([account("a"), account("b")], [pool]),
    cipher: cipher(),
    onRequest: (sample) => samples.push(sample),
    usage: { record: (row) => void rows.push(row) },
    fetch: async () => {
      calls++
      return calls === 1
        ? new Response("offline failure", { status: 500 })
        : new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
    },
  })
  const response = await dispatcher.dispatch(input())
  expect(samples).toHaveLength(0)
  await response.text()
  expect(calls).toBe(2)
  expect(rows).toHaveLength(2)
  expect(samples).toHaveLength(1)
  expect(samples[0]).toMatchObject({
    outcome: "success",
    requestedPoolIds: ["pool"],
    servedPoolId: "pool",
  })
})
