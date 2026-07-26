import { describe, expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import { createApp } from "../../src/app"
import { createLogger } from "../../src/logging/logger"
import { createMetrics } from "../../src/observability"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkInvoker,
  createSdkQuotaStore,
} from "../../src/providers"
import {
  createDispatcher,
  createHealthStore,
  createRateLimiter,
  createRouterKeyVerifier,
} from "../../src/services/dataplane"
import { sdkQueryStream, sdkTurn } from "../unit/claude-sdk/fixtures"
import {
  account,
  apiKeyRow,
  catalog,
  clock,
  jsonResponse,
  keyRepository,
  NOW,
  slowStream,
  subscriptionAccount,
  usageSink,
} from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, post, settle } from "./harness"

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

  test("a spent window filters the account out even while its breaker is fine", async () => {
    // The whole point of `quotaWindows` having a data source. This account is *not* limited — the
    // event is a warning, the breaker stays active, no cooldown is set — but its five-hour window
    // is full. Before a writer existed the router served straight into it; now the pure filter
    // drops it as `quota-window-spent` and the client is told which window and when it refills.
    const quota = createSdkQuotaStore()
    const persisted: { accountId: string; windows: readonly QuotaWindowState[] }[] = []
    const resetsAt = new Date(NOW.getTime() + 3_600_000)

    const { app, health } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [() => jsonResponse(500, {})],
      invokeSdk: invoker({
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 1,
        resetsAt: resetsAt.getTime(),
      }),
      sdkQuota: quota,
      health: { onQuotaWindows: (accountId, windows) => persisted.push({ accountId, windows }) },
    })

    const first = await app.request("/v1/messages", post(streamMessage(false), bearer()))
    await first.text()
    await settle()

    expect(first.status).toBe(200)
    expect(health.stateOf("sub").breaker.status).toBe("active")
    expect(health.stateOf("sub").quotaWindows).toEqual([
      {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "threshold-triggered",
        resetsAt,
        resetSource: "provider-reported",
        lastCheckedAt: expect.any(Date),
      },
    ])
    // The reading reached the durable writer, so a restart renders the same gauge.
    expect(persisted[0]?.accountId).toBe("sub")
    expect(persisted[0]?.windows[0]?.window).toBe("five_hour")

    const second = await app.request("/v1/messages", post(streamMessage(false), bearer()))
    const body = (await second.json()) as { error?: { message?: string } }
    await settle()

    // Clock-recoverable, so a 429 carrying the provider's own reset — never a 402, and never a 500.
    expect(second.status).toBe(429)
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(body.error?.message).toContain("out of quota")
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

/**
 * Every suite above answers through `harness()` (`./harness.ts`) — a purpose-built Hono instance
 * that mounts `dataPlaneRoutes` directly, hand-assembling its own `createDispatcher` call. That is
 * the right shape for asserting routing/translation/breaker properties in isolation, but it is a
 * second, parallel implementation of the wiring `composition/index.ts` does for real: a different
 * function builds the app, and a different call to `createDispatcher` passes a different, narrower
 * set of options.
 *
 * That gap is exactly how the flagship feature shipped 503 on every request while every test in
 * this repo stayed green (docs/idea/11-anthropic-agent-sdk.md's own postmortem, and Session 38's
 * fix): `composition/index.ts` never called `createDispatcher` with an `invokeSdk` at all, and
 * nothing here would have noticed, because nothing here calls `createApp` — the actual factory
 * `main.ts` boots — or builds the dispatcher the way `createRuntime` does (`limiter`, `prices`,
 * `translation`, `upstreamTimeoutMs` all present, not omitted).
 *
 * This suite closes that gap: it calls the real `createApp` (`src/app.ts`, `AppDeps.dataPlane`) and
 * builds the dispatcher with the same shape `createRuntime` builds it with. Only the two seams that
 * must never touch this host in a test are stood in for — `query()` and Postgres — exactly as
 * `composition/index.ts`'s own doc comments name them as the injected exceptions.
 */
describe("a subscription request through the real composition root, not a hand-wired harness", () => {
  function bootRealApp(invokeSdk: ReturnType<typeof invoker>) {
    const accounts = [subscriptionAccount("sub-1")]
    const testClock = clock()
    const metrics = createMetrics({ now: testClock.now })
    const store = catalog(accounts, [])
    const health = createHealthStore()
    const usage = usageSink()
    const usageWithMetrics = {
      record: (record: (typeof usage.rows)[number]) => {
        usage.record(record)
        metrics.observeUsage(record)
      },
    }

    const verifier = createRouterKeyVerifier({
      repository: keyRepository([apiKeyRow(KEY, CRYPTOR, { scope: "all" })]),
      cipher: CRYPTOR,
      loadScope: async () => ({ kind: "all" }),
      now: testClock.now,
    })

    // The same options composition/index.ts's createDispatcher call carries — a limiter, a
    // translation default, and an upstream timeout — none of which `./harness.ts` passes.
    const dispatcher = createDispatcher({
      catalog: store,
      health,
      cipher: CRYPTOR,
      usage: usageWithMetrics,
      limiter: createRateLimiter({ maxKeys: 16 }),
      invokeSdk,
      clock: testClock,
      onRequest: (sample) => metrics.observeRequest(sample),
      options: {
        failover: { maxAttempts: 3 },
        upstreamTimeoutMs: 30_000,
        translation: { defaultMaxTokens: 4096 },
      },
    })

    // `createApp` itself: the same factory `main.ts` calls with production deps. No `webRoot`, no
    // `admin` — a data-plane-only boot, which is what a router with no console build still serves.
    const app = createApp({
      logger: createLogger({ level: "error", write: () => {} }),
      probes: {
        database: () => Promise.resolve(true),
        accounts: () => Promise.resolve("ok"),
        claudeCli: () => Promise.resolve("platform_package"),
      },
      dataPlane: { verifier, dispatcher, catalog: store, health },
    })

    return { app, usage, health }
  }

  test("answers 200, not the 503 a missing invokeSdk wire would have produced", async () => {
    const { app, usage } = bootRealApp(invoker())

    const res = await app.request("/v1/messages", post(streamMessage(false), bearer()))
    const body = (await res.json()) as { type?: string; content?: unknown[] }
    await settle()

    expect(res.status).toBe(200)
    expect(body.type).toBe("message")
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ egressMode: "agent-sdk", outcome: "success" })
  })

  test("streams through the real app exactly as it does through the hand-wired one", async () => {
    const { app } = bootRealApp(invoker())

    const res = await app.request("/v1/messages", post(streamMessage(true), bearer()))
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(frameNames(text)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("an unauthenticated request never reaches the SDK invoker at all", async () => {
    const attempts: string[] = []
    const { app } = bootRealApp(async (invocation) => {
      attempts.push(invocation.accountId)
      throw new Error("must never be called")
    })

    const res = await app.request("/v1/messages", post(streamMessage(false)))

    expect(res.status).toBe(401)
    expect(attempts).toEqual([])
  })
})
