/**
 * A wall in a **streaming** client's `2xx` (developerz.ai plan 101 slice 07).
 *
 * Before content: the status line is held until the stream's first event that is not a preamble,
 * bounded by `UPSTREAM_STREAM_WALL_HOLD_MS`. A wall there fails over to a healthy sibling in the same
 * call; with nobody left the client hears the real `429`/`402`/`503`, never a `200`.
 *
 * After content: failover is over (bytes are on the wire). An upstream that breaks then ends the
 * client's stream with one router error event carrying `router`, never a cut connection.
 */
import { describe, expect, test } from "bun:test"
import type { Dialect } from "@multi-ai-router/core"
import { opaqueAccountRef } from "../../../src/errors/account-ref"
import { toErrorResponse } from "../../../src/errors/render"
import { httpDriver } from "../../../src/providers"
import {
  createDispatcher,
  createHealthStore,
  type RoutableAccount,
} from "../../../src/services/dataplane"
import { peekSuccess } from "../../../src/services/dataplane/success-wall"
import type { DeadlineClock } from "../../../src/services/dataplane/upstream-deadline"
import { account, catalog, cipher, mockUpstream } from "./fixtures"

const CRYPTOR = cipher()
const encoder = new TextEncoder()

const START = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`
const PING = 'event: ping\ndata: {"type":"ping"}\n\n'
const BLOCK = `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`
const DELTA = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"served"}}\n\n`
const END = `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
const STREAM = START + PING + BLOCK + DELTA + END
const RATE_LIMITED =
  'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n'

function sse(text: string): () => Response {
  return () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** An SSE body handed out one part per read, then a transport fault: content, then a reset. */
function breaksAfter(parts: readonly string[]): () => Response {
  return () => {
    let index = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[index]
        index += 1
        if (part === undefined) controller.error(new Error("connection reset by peer"))
        else controller.enqueue(encoder.encode(part))
      },
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
}

function accountOf(headers: Headers): string {
  return (headers.get("x-api-key") ?? "").replace(/^sk-/, "")
}

const REQUEST_ID = "req-stream-wall"

async function stream(
  ids: readonly string[],
  responses: readonly (() => Response)[],
  dialect: Dialect = "anthropic",
) {
  const accounts: RoutableAccount[] = ids.map((id) =>
    account(id, { provider: "anthropic-api", cipher: CRYPTOR }),
  )
  const health = createHealthStore()
  const upstream = mockUpstream(responses)
  const dispatcher = createDispatcher({
    catalog: catalog(accounts),
    cipher: CRYPTOR,
    health,
    usage: { record: () => {} },
    fetch: upstream.fetch,
  })
  const path = dialect === "anthropic" ? "/v1/messages" : "/v1/chat/completions"
  const body =
    dialect === "anthropic"
      ? { model: "m", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }
      : { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }
  let status: number
  let text: string
  try {
    const response = await dispatcher.dispatch({
      ingress: dialect,
      requestId: REQUEST_ID,
      key: {
        id: "key",
        name: "wall",
        prefix: "wall",
        scope: { kind: "all" },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request(`http://router.test${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    const rendered = toErrorResponse(error, dialect)
    status = rendered.status
    text = JSON.stringify(rendered.body)
  }
  return { status, text, calls: upstream.calls.map((call) => accountOf(call.headers)), health }
}

describe("a streaming client, wall before any content", () => {
  test("a ping is a preamble: an error after message_start + ping still fails over", async () => {
    const result = await stream(["a", "b"], [sse(START + PING + RATE_LIMITED), sse(STREAM)])

    expect(result.calls).toEqual(["a", "b"])
    expect(result.status).toBe(200)
    expect(result.text).toBe(STREAM)
  })

  test("with nobody left to walk to, the wall is a 429 carrying router.wall, never a 200", async () => {
    const result = await stream(["a"], [sse(RATE_LIMITED)])

    expect(result.status).toBe(429)
    const body = JSON.parse(result.text) as { error: { router: { wall: string } } }
    expect(body.error.router.wall).toBe("clock")
  })
})

describe("a streaming client, upstream breaks after content", () => {
  test("anthropic: the stream ends with one error event carrying router, not a reset", async () => {
    const result = await stream(["a", "b"], [breaksAfter([START, BLOCK, DELTA]), sse(STREAM)])

    expect(result.calls).toEqual(["a"])
    expect(result.status).toBe(200)
    expect(result.text.startsWith(START + BLOCK + DELTA)).toBe(true)
    const tail = result.text.slice((START + BLOCK + DELTA).length)
    expect(tail.startsWith("\n\nevent: error\ndata: ")).toBe(true)
    const event = JSON.parse(tail.slice("\n\nevent: error\ndata: ".length).trim()) as {
      type: string
      error: { type: string; message: string; router: unknown }
    }
    expect(event.type).toBe("error")
    expect(event.error.type).toBe("api_error")
    expect(event.error.router).toEqual({
      wall: "capacity",
      scope: "account",
      retryable: true,
      reset_at: null,
      reset_source: null,
      retry_after_s: null,
      accounts: [{ account: opaqueAccountRef("a"), state: "upstream_error", reset_at: null }],
      pools: [],
      signal: "upstream_error",
      attempts: 1,
      request_id: REQUEST_ID,
      reconnect: [],
    })
  })
})

/** Timers a test fires by hand. */
function fakeClock(): DeadlineClock & { advance(ms: number): void; armed(): number } {
  let now = 0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  return {
    now: () => now,
    after(delayMs, fn) {
      const timer = { at: now + delayMs, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    advance(ms) {
      now += ms
      for (const timer of timers) {
        if (!timer.live || timer.at > now) continue
        timer.live = false
        timer.fn()
      }
    },
    armed: () => timers.filter((timer) => timer.live).length,
  }
}

/** An upstream body the test writes to by hand. */
function handFed() {
  const pipe = new TransformStream<Uint8Array, Uint8Array>()
  const writer = pipe.writable.getWriter()
  return {
    response: new Response(pipe.readable, { headers: { "content-type": "text/event-stream" } }),
    write: (text: string) => void writer.write(encoder.encode(text)),
    close: () => void writer.close(),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the hold on a streaming client's status line", () => {
  const driver = httpDriver("anthropic-api")
  if (driver == null) throw new Error("missing anthropic-api driver")
  const base = { dialect: "anthropic" as const, driver, maxBytes: 65_536 }

  test("an upstream silent past the hold is committed, and nothing it sends later is lost", async () => {
    const clock = fakeClock()
    const upstream = handFed()
    let settled = false
    const peek = peekSuccess(upstream.response, { ...base, hold: { ms: 5_000, clock } }).finally(
      () => {
        settled = true
      },
    )
    upstream.write(START)
    await tick()
    expect(settled).toBe(false)

    clock.advance(5_000)
    const peeked = await peek
    if (peeked.kind !== "clear") throw new Error(`expected clear, got ${peeked.kind}`)

    upstream.write(BLOCK + DELTA)
    upstream.write(END)
    upstream.close()
    expect(await peeked.response.text()).toBe(START + BLOCK + DELTA + END)
  })

  test("a wall inside the hold is a wall, and the hold's timer is released", async () => {
    const clock = fakeClock()
    const upstream = handFed()
    const peek = peekSuccess(upstream.response, { ...base, hold: { ms: 5_000, clock } })
    upstream.write(START)
    await tick()
    clock.advance(4_999)
    upstream.write(RATE_LIMITED)

    const peeked = await peek
    expect(peeked.kind).toBe("wall")
    expect(peeked.kind === "wall" ? peeked.status : 0).toBe(429)
    expect(clock.armed()).toBe(0)
  })

  test("a first content event commits at once: the hold adds nothing to time to first token", async () => {
    const clock = fakeClock()
    const upstream = handFed()
    const peek = peekSuccess(upstream.response, { ...base, hold: { ms: 5_000, clock } })
    upstream.write(START + BLOCK)

    const peeked = await peek
    expect(peeked.kind).toBe("clear")
    expect(clock.armed()).toBe(0)
    upstream.close()
  })
})
