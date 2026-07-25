import { describe, expect, test } from "bun:test"
import { createSdkQuotaStore, renderSdkResponse, type SdkInvocation } from "../../src/providers"
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
 * SDK-backed account whose `invokeSdk` stub is the same seam a real launcher would fill — it reads
 * the client's `stream` flag off the converted body, drives `renderSdkResponse` with a `query()`-
 * shaped fixture stream, and answers with exactly what that renderer produces. Nothing here spawns
 * a `claude` subprocess and no fixture carries a real credential.
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

/** What a real launcher reads off the converted body to decide which shape to render. */
function wantsStream(body: Uint8Array | null): boolean {
  if (body === null) return false
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { stream?: unknown }).stream === true
  )
}

function sdkTextTurn(rateLimitInfo?: Record<string, unknown>) {
  return sdkQueryStream({
    turns: [sdkTurn({ blocks: [TEXT_BLOCK] })],
    ...(rateLimitInfo === undefined ? {} : { rateLimitInfo }),
    result: { stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } },
  })
}

/**
 * The stand-in for a real launcher: reads `stream` off the converted body, drives
 * `renderSdkResponse` with a `query()`-shaped fixture stream, and forwards the renderer's own
 * observer callbacks to the ones `runSdkAttempt` passed in — the same bridge a real launcher owns
 * between `query()`'s messages and the invocation's `onSession`/`onRateLimit`.
 */
function invoker(rateLimitInfo?: Record<string, unknown>) {
  return (invocation: SdkInvocation) =>
    renderSdkResponse({
      messages: sdkTextTurn(rateLimitInfo),
      model: invocation.model,
      stream: wantsStream(invocation.body),
      observer: {
        onSession: invocation.onSession
          ? (id) => invocation.onSession?.({ sdkSessionId: id })
          : undefined,
        onRateLimit: invocation.onRateLimit,
      },
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
