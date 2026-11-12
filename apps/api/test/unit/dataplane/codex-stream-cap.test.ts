import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import { createEventTally } from "../../../src/services/dataplane/stream-cap"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

// Plan 101, 12.8: 119 Codex streams on one customer deployment ended at 895–905 s with no `response.completed`
// (http 200, streamed, error_class `upstream_error`, tokens_out 0). The router has no 900 s clock:
// the upstream ends them. They must be named (`codex:stream-cap`) and the failure line must say
// which event types arrived — never cut by the router, never retried after bytes.

const encoder = new TextEncoder()
const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }),
).toString("base64url")}.sig`

async function codexStream(options: { capMinMs?: number } = {}) {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined
  let elapsed = 0
  const rows: UsageRecord[] = []
  const lines: Record<string, unknown>[] = []
  const log = createLogger({ level: "info", write: (line) => void lines.push(JSON.parse(line)) })
  const cryptor = cipher()
  const a = {
    ...account("a", { provider: "openai-oauth", cipher: cryptor }),
    authMaterial: cryptor.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
  const routing = catalog([a])
  const dispatcher = createDispatcher({
    logger: log,
    catalog: routing,
    recovery: {
      catalog: routing,
      retryAfterMs: 1000,
      quotaStaleAfterMs: 1000,
      currentSnapshot: () => routing.accounts()[0]?.snapshot,
      hint: () => {},
      forget: () => {},
      prepare: () => ({
        designated: false,
        started: () => true,
        beforeUpstreamStart: () => {},
        finish: () => {},
      }),
    },
    activeRequests: createActiveRequestRegistry({ maximumEntries: 10 }),
    cipher: cryptor,
    health: createHealthStore({ jitter: () => 0 }),
    usage: { record: (row) => void rows.push(row) },
    clock: { now: () => new Date(), elapsed: () => elapsed },
    options: {
      log: { reasonMaxChars: 200 },
      ...(options.capMinMs === undefined ? {} : { upstreamStreamCapMinMs: options.capMinMs }),
    },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller
            controller.enqueue(
              encoder.encode(
                ': open\n\nevent: response.created\ndata: {"type":"response.created"}\n\n',
              ),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const response = await dispatcher.dispatch({
    ingress: "openai-responses",
    requestId: crypto.randomUUID(),
    key: {
      id: "key",
      name: "codex-test",
      prefix: "codex-test",
      scope: { kind: "accounts", accountIds: ["a"] },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6.1-sol", input: "ping" }),
    }),
  })
  if (source === undefined || response.body === null) throw new Error("missing stream")
  const upstream = source
  const reader = response.body.getReader()
  await reader.read()
  return {
    rows,
    lines,
    reader,
    send: async (frame: string) => {
      upstream.enqueue(encoder.encode(frame))
      await reader.read()
    },
    /** The upstream drops the connection after `ms` of stream. */
    reset: async (ms: number) => {
      elapsed += ms
      upstream.error(Object.assign(new TypeError("socket closed"), { code: "ECONNRESET" }))
      while (!(await reader.read().catch(() => ({ done: true }))).done) {}
      await Promise.resolve()
    },
  }
}

const progress = 'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n'
const reasoning =
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"secret thought"}\n\n'

describe("a Codex stream the upstream ends without completing", () => {
  test("past the cap minimum it is recorded as codex:stream-cap, still an upstream error", async () => {
    const s = await codexStream()
    await s.send(progress)
    await s.reset(900_000)
    expect(s.rows).toHaveLength(1)
    expect(s.rows[0]).toMatchObject({
      outcome: "upstream_error",
      errorClass: "codex:stream-cap",
      streamed: true,
      httpStatus: 200,
    })
  })

  test("the failure line counts the event types that arrived, and no content", async () => {
    const s = await codexStream()
    await s.send(progress)
    await s.send(reasoning)
    await s.send(reasoning)
    await s.reset(900_000)
    const line = s.lines.find((entry) => entry.msg === "upstream stream failure")
    expect(line?.eventTypes).toEqual({
      "response.created": 1,
      "response.in_progress": 1,
      "response.reasoning_summary_text.delta": 2,
    })
    expect(JSON.stringify(s.lines)).not.toContain("secret thought")
  })

  test("before the cap minimum it stays a plain upstream_error", async () => {
    const s = await codexStream()
    await s.reset(60_000)
    expect(s.rows[0]?.errorClass).toBe("upstream_error")
  })

  test("the cap minimum is an option", async () => {
    const s = await codexStream({ capMinMs: 30_000 })
    await s.reset(60_000)
    expect(s.rows[0]?.errorClass).toBe("codex:stream-cap")
  })
})

describe("the event tally", () => {
  test("is bounded in distinct names and in name shape", () => {
    const tally = createEventTally()
    for (let i = 0; i < 40; i++) tally.note({ type: `response.kind_${i}` }, undefined)
    tally.note({ type: "Bad Name <script>" }, undefined)
    tally.note({}, undefined)
    const counts = tally.counts()
    expect(Object.keys(counts)).toHaveLength(25)
    expect(counts.other).toBe(18)
  })
})
