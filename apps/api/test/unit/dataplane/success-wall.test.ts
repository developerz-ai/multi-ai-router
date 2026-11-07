/**
 * A wall that arrives inside a `2xx` is classified **before** the response is committed.
 *
 * MiniMax answers a drained balance with `200` and a `base_resp` envelope; Anthropic-shaped
 * upstreams open a stream with `200` and then send `event: error` as the first event. Both used to
 * be handed back as a success: the client got the error body under a `200` (a fake success), the
 * account was struck only after the relay finished, and the healthy sibling beside it was never
 * asked. While no byte has reached the client, failover is still open — so the wall is read off the
 * front of the body, the attempt becomes the failure it is, and the chain walks on. With nobody
 * left to walk to, the client hears the real `402` / `429` / `503`, never a `200`.
 */
import { describe, expect, test } from "bun:test"
import type { Dialect } from "@multi-ai-router/core"
import { toErrorResponse } from "../../../src/errors/render"
import { httpDriver } from "../../../src/providers"
import type { RoutableAccount } from "../../../src/services/dataplane"
import {
  createDispatcher,
  createHealthStore,
  type HealthStore,
} from "../../../src/services/dataplane"
import { peekSuccess } from "../../../src/services/dataplane/success-wall"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher, mockUpstream } from "./fixtures"

const CRYPTOR = cipher()

type Provider = Parameters<typeof account>[1] extends infer O
  ? O extends { provider?: infer P }
    ? NonNullable<P>
    : never
  : never

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "served" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
}

const STREAM = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...MESSAGE, content: [] } })}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"served"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("")

const MINIMAX_BROKE = { base_resp: { status_code: 1008, status_msg: "insufficient balance" } }

function json(body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
}

function sse(text: string): () => Response {
  return () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
}

interface Run {
  readonly status: number
  readonly body: string
  readonly calls: readonly string[]
  readonly health: HealthStore
  readonly rows: readonly UsageRecord[]
}

/** Which account a call went to: each fixture account authenticates with `sk-<id>`. */
function accountOf(headers: Headers): string {
  const codex = headers.get("chatgpt-account-id")
  if (codex !== null) return codex
  const presented = headers.get("x-api-key") ?? headers.get("authorization") ?? ""
  return presented.replace(/^Bearer /, "").replace(/^sk-/, "")
}

/** A Codex account: its access token carries the `chatgpt_account_id` claim the driver requires. */
function codexAccount(id: string): RoutableAccount {
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } }),
  ).toString("base64url")}.sig`
  return {
    ...account(id, { provider: "openai-oauth", cipher: CRYPTOR }),
    authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: token })),
  }
}

interface Ingress {
  readonly dialect: Dialect
  readonly path: string
  readonly body: Record<string, unknown>
}

const MESSAGES: Ingress = {
  dialect: "anthropic",
  path: "/v1/messages",
  body: { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
}

async function run(
  provider: Provider,
  ids: readonly string[],
  responses: readonly (() => Response)[],
  stream = false,
): Promise<Run> {
  return runOn(
    ids.map((id) => account(id, { provider })),
    responses,
    { ...MESSAGES, body: { ...MESSAGES.body, stream } },
  )
}

async function runOn(
  accounts: readonly RoutableAccount[],
  responses: readonly (() => Response)[],
  ingress: Ingress,
): Promise<Run> {
  const health = createHealthStore()
  const rows: UsageRecord[] = []
  const upstream = mockUpstream(responses)
  const dispatcher = createDispatcher({
    catalog: catalog(accounts),
    cipher: CRYPTOR,
    health,
    usage: { record: (row) => void rows.push(row) },
    fetch: upstream.fetch,
  })
  let status: number
  let body: string
  try {
    const response = await dispatcher.dispatch({
      ingress: ingress.dialect,
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "wall",
        prefix: "wall",
        scope: { kind: "all" },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request(`http://router.test${ingress.path}`, {
        method: "POST",
        body: JSON.stringify(ingress.body),
      }),
    })
    status = response.status
    body = await response.text()
  } catch (error) {
    const rendered = toErrorResponse(error, ingress.dialect)
    status = rendered.status
    body = JSON.stringify(rendered.body)
  }
  return {
    status,
    body,
    calls: upstream.calls.map((call) => accountOf(call.headers)),
    health,
    rows,
  }
}

describe("a wall inside a 2xx, with a healthy sibling", () => {
  test("a MiniMax 200 carrying base_resp 1008 fails over and parks the drained account", async () => {
    const result = await run("minimax", ["a", "b"], [json(MINIMAX_BROKE), json(MESSAGE)])

    expect(result.calls).toHaveLength(2)
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ content: [{ text: "served" }] })
    const [walled, served] = result.calls as [string, string]
    expect(result.health.stateOf(walled).breaker.status).toBe("exhausted")
    expect(result.health.stateOf(served).breaker.status).toBe("active")
  })

  test("an upstream stream whose first event is an error fails over before a byte is relayed", async () => {
    const overloaded =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    const result = await run("anthropic-api", ["a", "b"], [sse(overloaded), sse(STREAM)])

    expect(result.calls).toHaveLength(2)
    expect(result.status).toBe(200)
    expect(result.body).toBe(STREAM)
  })

  test("an error right after message_start is still a wall: the peek reads past the preamble", async () => {
    const opened = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...MESSAGE, content: [] } })}\n\n`
    const limited = `${opened}event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n`
    const result = await run("anthropic-api", ["a", "b"], [sse(limited), sse(STREAM)])

    expect(result.calls).toHaveLength(2)
    expect(result.body).toBe(STREAM)
    expect(result.health.stateOf(result.calls[0] as string).breaker.status).toBe("cooling_down")
  })

  test("a streaming client is failed over too: a first-event error never reaches it", async () => {
    // Its status line is held only until the first event decides, bounded by
    // `UPSTREAM_STREAM_WALL_HOLD_MS` (`success-wall.ts`); a wall decides at once.
    const overloaded =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    const result = await run("anthropic-api", ["a", "b"], [sse(overloaded), sse(STREAM)], true)

    expect(result.calls).toHaveLength(2)
    expect(result.status).toBe(200)
    expect(result.body).toBe(STREAM)
  })

  test("a streaming client is failed over on an error right after message_start", async () => {
    const opened = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...MESSAGE, content: [] } })}\n\n`
    const limited = `${opened}event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n`
    const result = await run("anthropic-api", ["a", "b"], [sse(limited), sse(STREAM)], true)

    expect(result.calls).toHaveLength(2)
    expect(result.status).toBe(200)
    expect(result.body).toBe(STREAM)
    expect(result.health.stateOf(result.calls[0] as string).breaker.status).toBe("cooling_down")
  })

  test("a Codex response.failed after response.created is a wall for a client that is not streaming", async () => {
    const created = `event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress"}}\n\n`
    const failed = `${created}event: response.failed\ndata: {"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"usage_limit_reached","message":"spent"}}}\n\n`
    const completed = `${created}event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n`
    const result = await runOn(
      [codexAccount("a"), codexAccount("b")],
      [sse(failed), sse(completed)],
      {
        dialect: "openai-responses",
        path: "/v1/responses",
        body: { model: "gpt-6.1-sol", input: "hi" },
      },
    )

    expect(result.calls).toHaveLength(2)
    expect(result.status).toBe(200)
    expect(result.health.stateOf(result.calls[0] as string).breaker.status).toBe("cooling_down")
  })
})

describe("a wall inside a 2xx, with nobody left to walk to", () => {
  test("a drained balance is a 402, never a 200", async () => {
    const result = await run("minimax", ["a"], [json(MINIMAX_BROKE)])

    expect(result.calls).toHaveLength(1)
    expect(result.status).toBe(402)
  })

  test("an in-stream rate limit is a 429 with a Retry-After, never a 200", async () => {
    const limited =
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n'
    const result = await run("anthropic-api", ["a"], [sse(limited)])

    expect(result.status).toBe(429)
  })

  test("an in-stream overload is a 503, never a 200", async () => {
    const overloaded =
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    const result = await run("anthropic-api", ["a"], [sse(overloaded)])

    expect(result.status).toBe(503)
  })
})

describe("what the peek leaves alone", () => {
  test("a healthy stream is relayed byte for byte and tried once", async () => {
    const result = await run("anthropic-api", ["a", "b"], [sse(STREAM)])

    expect(result.calls).toHaveLength(1)
    expect(result.body).toBe(STREAM)
  })

  test("a healthy JSON body is relayed byte for byte", async () => {
    const result = await run("minimax", ["a"], [json(MESSAGE)])

    expect(result.status).toBe(200)
    expect(result.body).toBe(JSON.stringify(MESSAGE))
  })

  test("an error after the first content event is past the commit point: relayed, not retried", async () => {
    const late = `${STREAM.split("event: content_block_delta")[0]}event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`
    const result = await run("anthropic-api", ["a", "b"], [sse(late), sse(STREAM)])

    expect(result.calls).toHaveLength(1)
    expect(result.status).toBe(200)
  })
})

describe("the peek's own edges", () => {
  const driver = httpDriver("anthropic-api")
  if (driver == null) throw new Error("missing anthropic-api driver")
  const input = { dialect: "anthropic" as const, driver, maxBytes: 65_536 }
  const streamOf = (...parts: readonly string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )

  test("a chunk that splits a data line at a colon is not a keepalive comment", async () => {
    const peeked = await peekSuccess(
      streamOf(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"a',
        ': b"}',
        "}\n\n",
      ),
      input,
    )

    expect(peeked.kind).toBe("wall")
  })

  test("a whole comment line commits, and every byte is replayed in order", async () => {
    const parts = [
      ": keepalive\n\n",
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
    ]
    const peeked = await peekSuccess(streamOf(...parts), input)

    if (peeked.kind !== "clear") throw new Error(`expected clear, got ${peeked.kind}`)
    expect(await peeked.response.text()).toBe(parts.join(""))
  })

  test("an upstream that breaks inside the peek is a transport fault, thrown", async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("connection reset"))
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )

    await expect(peekSuccess(broken, input)).rejects.toThrow("connection reset")
  })
})
