import { describe, expect, test } from "bun:test"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkInvoker,
  createSdkQuotaStore,
} from "../../src/providers"
import { sdkQueryStream, sdkTurn } from "../unit/claude-sdk/fixtures"
import {
  account,
  jsonResponse,
  NOW,
  slowStream,
  subscriptionAccount,
} from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * The Agent-SDK transport end to end: `harness()` (`dataplane.test.ts:70-92`) extended with an
 * SDK-backed account served by the **real** `createSdkInvoker` — the same object `composition/`
 * builds in production, with only the two pieces that touch this host injected: `query()` itself
 * and the executable-resolution ladder. Nothing here spawns a `claude` subprocess and no fixture
 * carries a real credential.
 *
 * That the launcher is real is the point. A stand-in that reads the `stream` flag and drives the
 * renderer would assert the renderer twice and the transport never once, which is exactly how a
 * dispatch path can be green in tests and `503` in production.
 *
 * `dataplane.test.ts`'s "the Agent-SDK transport" suite already covers the failover, session-replay,
 * and error-mapping properties at the `SdkInvoker` boundary with a pre-built `Response`. This file
 * is the layer beneath that: what a client actually receives once the real renderer and the real
 * quota store are in the loop.
 */

const TEXT_BLOCK = [
  { type: "text", text: "" },
  { type: "text_delta", text: "hi" },
] as const

function streamMessage(stream: boolean): string {
  return JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 64,
    stream,
    messages: [{ role: "user", content: "hello" }],
  })
}

function sdkTextTurn(rateLimitInfo?: Record<string, unknown>) {
  return sdkQueryStream({
    turns: [sdkTurn({ blocks: [TEXT_BLOCK] })],
    ...(rateLimitInfo === undefined ? {} : { rateLimitInfo }),
    result: { stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } },
  })
}

/** The rung `resolve-cli.ts` would have reported, so no filesystem is walked and none is needed. */
const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 245_000_000,
}

/**
 * The production invoker, with the subprocess replaced by a `query()`-shaped fixture stream.
 *
 * Everything between the client's bytes and that stream is real: the body is read once, the prompt
 * is built from the lineage plan, the concurrency slot is taken and released, the launch carries
 * every isolation flag, and the renderer's observers are bridged to `onSession`/`onRateLimit`.
 */
function invoker(rateLimitInfo?: Record<string, unknown>) {
  return createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
    resolveCli: () => CLI,
    runQuery: () => sdkTextTurn(rateLimitInfo),
  })
}

/** `event: <type>` frame names, in order — the SSE grammar both transports emit. */
function frameNames(sse: string): string[] {
  return sse
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => block.split("\n")[0]?.slice("event: ".length) ?? "")
}

describe("a streaming SDK response", () => {
  test("is byte-shaped like a passthrough Anthropic stream", async () => {
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: invoker(),
    })

    const res = await app.request("/v1/messages", post(streamMessage(true), bearer()))
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    // Same event grammar and ordering an Anthropic passthrough stream relays byte for byte
    // (`event: <type>\ndata: <json>\n\n`, one message_start, one message_stop).
    expect(frameNames(text)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(text).toContain('"type":"text_delta"')
  })

  test("matches the frame sequence a real passthrough Anthropic account emits for the same turn", async () => {
    const anthropicSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const slow = slowStream([anthropicSse])
    const passthrough = harness({
      accounts: [account("api-1", { apiKey: "sk-one", cipher: CRYPTOR })],
      responses: [() => slow.response],
    })
    const sdk = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: invoker(),
    })

    const passthroughRes = await passthrough.app.request(
      "/v1/messages",
      post(streamMessage(true), bearer()),
    )
    slow.release(0)
    slow.finish()
    const [passthroughText, sdkRes] = await Promise.all([
      passthroughRes.text(),
      sdk.app.request("/v1/messages", post(streamMessage(true), bearer())),
    ])
    const sdkText = await sdkRes.text()

    expect(frameNames(sdkText)).toEqual(frameNames(passthroughText))
  })
})

describe("an OpenAI-dialect client against the same subscription account", () => {
  /**
   * §6's "one renderer, not one per dialect", proven end to end: the request is translated into
   * Anthropic on the way in, the SDK is rendered into Anthropic **once**, and the ordinary
   * Anthropic → openai-chat translator carries it the rest of the way. A second SDK → OpenAI
   * renderer would be a second place for the loss to happen differently.
   */
  const CHAT = JSON.stringify({
    model: "claude-opus-5",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  })

  test("gets chat.completion chunks, never Anthropic frames", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: invoker(),
    })

    const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
    const text = await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text).toContain('"content":"hi"')
    expect(text).toContain("data: [DONE]")
    // The SDK's own event names never survive the crossing.
    expect(text).not.toContain("event: content_block_delta")
    expect(usage.rows[0]).toMatchObject({ egressMode: "agent-sdk", outcome: "success" })
  })
})

describe("usage accounting", () => {
  test("a UsageRecord lands with egressMode agent-sdk for a streaming turn", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: invoker(),
    })

    const res = await app.request("/v1/messages", post(streamMessage(true), bearer()))
    await res.text()
    await settle()

    expect(usage.rows[0]).toMatchObject({ egressMode: "agent-sdk", outcome: "success" })
    expect(usage.rows[0]?.tokensIn).toBeGreaterThan(0)
    expect(usage.rows[0]?.tokensOut).toBeGreaterThan(0)
  })
})

describe("a rate-limit event mid-stream", () => {
  test("cools the account down — 429 + Retry-After on the next request, never exhausted", async () => {
    const quota = createSdkQuotaStore()
    const resetsAt = new Date(NOW.getTime() + 3_600_000)

    const { app, health } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: invoker({
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: resetsAt.getTime(),
      }),
      sdkQuota: quota,
    })

    // The first turn still answers — the reading is account state, never a client-visible refusal.
    const first = await app.request("/v1/messages", post(streamMessage(false), bearer()))
    await first.text()
    await settle()
    expect(first.status).toBe(200)
    expect(health.stateOf("sub").breaker.status).toBe("cooling_down")

    const second = await app.request("/v1/messages", post(streamMessage(false), bearer()))
    await settle()

    expect(second.status).toBe(429)
    expect(second.headers.get("retry-after")).not.toBeNull()
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  test("an accompanying warning never cools the account down on its own", async () => {
    const quota = createSdkQuotaStore()
    const { app, health } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: invoker({ status: "allowed_warning", rateLimitType: "five_hour" }),
      sdkQuota: quota,
    })

    const res = await app.request("/v1/messages", post(streamMessage(false), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(health.stateOf("sub").breaker.status).toBe("active")
  })
})
