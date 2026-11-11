import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * 101 finding 10.4: since 2.55.0, `response_format` on a fast-mode Claude subscription travels as
 * native `output_config.format`, and Anthropic answered prod schemas with `400 Schema is too
 * complex.` after a ~180 s grammar compile (46 ×), `Grammar compilation timed out` (2 ×), and
 * `output_config.format.schema: For 'array' type, property 'maxItems' is not supported` (13 ×).
 * The router relayed each 400. Now: a schema outside the native subset rides the adapted tool
 * before anything is sent; a native refusal or a stalled compile is re-sent once on the tool,
 * same Account, before any byte reached the client; one UsageRecord per request either way.
 */

const TOKEN = "fast-selected-account-token"
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`
const answer = '{"ok":true}'
const toolWire = [
  event({
    type: "message_start",
    message: {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      usage: { input_tokens: 3 },
    },
  }),
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "router_structured_output", input: {} },
  }),
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: answer },
  }),
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }),
  event({ type: "message_stop" }),
].join("")

const textWire = [
  event({
    type: "message_start",
    message: {
      id: "msg_json",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      usage: { input_tokens: 3 },
    },
  }),
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } }),
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
  event({ type: "message_stop" }),
].join("")

const closed = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}

type Upstream = (request: Request, call: number) => Promise<Response>

function fastRouter(upstream: Upstream) {
  const sent: Record<string, unknown>[] = []
  const lines: Record<string, unknown>[] = []
  let calls = 0
  const logger = createLogger({
    level: "warn",
    write: (line) => {
      lines.push(JSON.parse(line))
    },
  })
  const invokeSdk = createFastInvoker({
    logger,
    concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
    errorMaxBytes: 4096,
    nativeSchemaTimeoutMs: 50,
    credential: async () => ({
      accessToken: TOKEN,
      expiresAt: Date.now() + 3_600_000,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    resolveModel: (_, model) => model,
    sdk: async () => new Response("unexpected SDK fallback", { status: 500 }),
    fetch: async (request) => {
      sent.push(JSON.parse(await request.clone().text()))
      calls += 1
      return upstream(request, calls)
    },
  })
  const { app, usage } = harness({
    accounts: [subscriptionAccount("sub")],
    responses: [],
    maxAttempts: 1,
    invokeSdk,
    logger,
  })
  return { app, usage, sent, lines }
}

const sse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } })
const rejection = (message: string) =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  )
/** An upstream that never answers until the request is aborted: the 180 s compile. */
const stalled = (request: Request) =>
  new Promise<Response>((_, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
  })

function chat(schema: Record<string, unknown>): string {
  return JSON.stringify({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: "answer ok" }],
    response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
  })
}

async function contentOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { choices: { message: { content: string } }[] }
  return JSON.parse(body.choices[0]?.message.content ?? "null")
}

describe("native structured output on a fast-mode Claude subscription (10.4)", () => {
  test("a schema with maxItems goes native reduced: one send, the bound restated as text", async () => {
    const h = fastRouter(async () => sse(textWire))
    const schema = {
      ...closed,
      properties: {
        ok: { type: "boolean" },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
    }
    const response = await h.app.request("/v1/chat/completions", post(chat(schema), bearer()))
    await settle()
    expect(response.status).toBe(200)
    expect(await contentOf(response)).toEqual(JSON.parse(answer))
    expect(h.sent).toHaveLength(1)
    const sent = JSON.stringify(h.sent[0]?.output_config)
    expect(sent).not.toContain('"maxItems"')
    expect(sent).toContain("maxItems: 3")
    expect(h.usage.rows).toHaveLength(1)
  })

  test("a schema past the budget never goes native: one send, on the adapted tool", async () => {
    const h = fastRouter(async () => sse(toolWire))
    const properties = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`p${i}`, { type: "string" }]),
    )
    const response = await h.app.request(
      "/v1/chat/completions",
      post(chat({ ...closed, properties, required: [] }), bearer()),
    )
    await settle()
    expect(response.status).toBe(200)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).not.toHaveProperty("output_config")
    expect(h.sent[0]?.tool_choice).toEqual({ type: "auto" })
    expect(h.usage.rows).toHaveLength(1)
  })

  test("'Schema is too complex.' is re-sent once on the tool and served", async () => {
    const h = fastRouter(async (_, call) =>
      call === 1 ? rejection("Schema is too complex.") : sse(toolWire),
    )
    const response = await h.app.request("/v1/chat/completions", post(chat(closed), bearer()))
    await settle()
    expect(response.status).toBe(200)
    expect(await contentOf(response)).toEqual(JSON.parse(answer))
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]?.output_config).toEqual({ format: { type: "json_schema", schema: closed } })
    expect(h.sent[1]).not.toHaveProperty("output_config")
    expect(h.sent[1]?.tools).toMatchObject([{ name: "router_structured_output" }])
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]?.outcome).toBe("success")
    const warn = h.lines.find((line) => String(line.msg).includes("native structured-output"))
    expect(warn?.reason).toBe("schema-rejected")
    expect(JSON.stringify(h.lines)).not.toContain(TOKEN)
  })

  test("a compile that stalls past the header bound is abandoned and served on the tool", async () => {
    const h = fastRouter((request, call) =>
      call === 1 ? stalled(request) : Promise.resolve(sse(toolWire)),
    )
    const started = Date.now()
    const response = await h.app.request("/v1/chat/completions", post(chat(closed), bearer()))
    await settle()
    expect(response.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await contentOf(response)).toEqual(JSON.parse(answer))
    expect(h.sent).toHaveLength(2)
    const warn = h.lines.find((line) => String(line.msg).includes("native structured-output"))
    expect(warn?.reason).toBe("header-timeout")
    expect(h.usage.rows).toHaveLength(1)
  })

  test("a refused schema is remembered: the next request with it skips native entirely", async () => {
    const h = fastRouter(async (_, call) =>
      call === 1 ? rejection("Grammar compilation timed out") : sse(toolWire),
    )
    await h.app.request("/v1/chat/completions", post(chat(closed), bearer()))
    const second = await h.app.request("/v1/chat/completions", post(chat(closed), bearer()))
    await settle()
    expect(second.status).toBe(200)
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2]).not.toHaveProperty("output_config")
  })

  test("a 400 that is not about the schema is relayed, not retried", async () => {
    const h = fastRouter(async () => rejection("messages: text content blocks must be non-empty"))
    const response = await h.app.request("/v1/chat/completions", post(chat(closed), bearer()))
    await settle()
    expect(response.status).toBe(400)
    expect(h.sent).toHaveLength(1)
    expect(h.usage.rows).toHaveLength(1)
  })
})
