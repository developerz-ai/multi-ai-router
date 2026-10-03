import { expect, test } from "bun:test"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { readRequestBody } from "../../../src/services/dataplane/body/read"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

const payload = new TextEncoder().encode(
  JSON.stringify({
    model: "claude",
    max_tokens: 1,
    messages: [{ role: "user", content: "offline" }],
  }),
)

function upload(wait: () => void) {
  let sent = false
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (sent) {
          controller.close()
          return
        }
        await Promise.resolve()
        wait()
        sent = true
        controller.enqueue(payload)
      },
    },
    { highWaterMark: 0 },
  )
}

test("body reader measures awaited upload separately from subsequent observer work", async () => {
  let elapsed = 0
  let measured = 0
  const result = await readRequestBody(
    {
      headers: new Headers(),
      body: upload(() => {
        elapsed += 100
      }),
    },
    {
      elapsed: () => elapsed,
      onReadWait: (ms) => {
        measured += ms
        elapsed += 7
      },
    },
  )
  expect(result.bytes).toEqual(payload)
  expect(result.fields.model).toBe("claude")
  expect(measured).toBe(100)
  expect(elapsed).toBeGreaterThan(measured)
})

test("actual dispatcher retains upload latency while excluding it from router overhead", async () => {
  let elapsed = 0
  const rows: UsageRecord[] = []
  const samples: { durationMs: number }[] = []
  const dispatcher = createDispatcher({
    catalog: catalog([account("offline")]),
    cipher: cipher(),
    health: createHealthStore(),
    clock: { now: () => new Date(elapsed), elapsed: () => elapsed },
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
    onRequest: (sample) => {
      samples.push(sample)
    },
    fetch: async () => {
      elapsed += 5
      return new Response(
        JSON.stringify({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  const response = await dispatcher.dispatch({
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
      body: upload(() => {
        elapsed += 100
      }),
    }),
  })
  await response.arrayBuffer()
  expect(response.status).toBe(200)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.routerOverheadMs).toBe(0)
  expect(samples[0]?.durationMs).toBe(105)
  expect(rows[0]?.ttfbMs).toBe(105)
})
