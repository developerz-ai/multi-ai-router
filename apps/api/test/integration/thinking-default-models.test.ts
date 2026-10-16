import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { createMetrics } from "../../src/observability"
import { dataPlaneRoutes } from "../../src/routes/v1"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
  type RoutableAccount,
} from "../../src/services/dataplane"
import { createThinkingDefaultMatcher } from "../../src/services/translate"
import type { AppEnv } from "../../src/types"
import {
  account,
  apiKeyRow,
  catalog,
  clock,
  jsonResponse,
  keyRepository,
  mockUpstream,
  usageSink,
} from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, KEY, post, settle } from "./harness"

/**
 * End-to-end: the `enable_thinking: false` vendor dial on a forced-tool anthropic → openai-chat
 * request bound for a think-by-default model named in `OPENAI_CHAT_THINKING_DEFAULT_MODELS`.
 *
 * Built inline rather than through `harness()` because only this suite threads the translation
 * matcher (every other integration suite leaves it unset). The matcher is built **once** from the
 * configured list, the way the composition root does (`composition/dispatch-options.ts`).
 *
 * Pre-wiring (HEAD) this field was never emitted by any path, so the in-set forced case below could
 * not pass — the assertion is the regression gate for the fix.
 */
function wire(accounts: readonly RoutableAccount[], thinkingDefaultModels: readonly string[]) {
  const upstream = mockUpstream([() => REPLY])
  const usage = usageSink()
  const health = createHealthStore({ jitter: () => 0 })
  const testClock = clock()
  const metrics = createMetrics({ now: testClock.now })
  const store = catalog(accounts, [])
  const verifier = createRouterKeyVerifier({
    repository: keyRepository([apiKeyRow(KEY, CRYPTOR, { scope: "all" })]),
    cipher: CRYPTOR,
    loadScope: async () => ({ kind: "all" }),
  })
  const app = new Hono<AppEnv>()
  const logger = createLogger({ level: "error", write: () => undefined })
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    "/",
    dataPlaneRoutes({
      verifier,
      catalog: store,
      health,
      now: testClock.now,
      dispatcher: createDispatcher({
        catalog: store,
        health,
        cipher: CRYPTOR,
        usage,
        fetch: upstream.fetch,
        clock: testClock,
        onRequest: (sample) => metrics.observeRequest(sample),
        options: {
          failover: { maxAttempts: 3 },
          translation: {
            thinkingDefaultModels: createThinkingDefaultMatcher(thinkingDefaultModels),
          },
        },
      }),
    }),
  )
  return { app, upstream, usage }
}

const REPLY = jsonResponse(200, {
  id: "chatcmpl-1",
  model: "qwen3.8-max",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "json", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
})

function forcedBody(model: string) {
  return JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: "give me json" }],
    tools: [{ name: "json", description: "Respond as JSON", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "json" },
  })
}

function sentBody(upstream: { calls: readonly { body: string }[] }): Record<string, unknown> {
  return JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
}

// The model the client asks for is set per request (`forcedBody`); the account only supplies the
// openai-compatible egress, so the id carried upstream is the client's, unaliased.
const qwen = () =>
  account("qwen", {
    provider: "openai-compatible",
    apiKey: "sk-qwen",
    cipher: CRYPTOR,
    dialect: "openai-chat",
  })

describe("OPENAI_CHAT_THINKING_DEFAULT_MODELS end to end", () => {
  test("forced tool + model in set: upstream body carries enable_thinking:false, usage row lands", async () => {
    const { app, upstream, usage } = wire([qwen()], ["qwen3.8-max", "qwen3.8-flash"])

    const res = await app.request("/v1/messages", post(forcedBody("qwen3.8-max"), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    const sent = sentBody(upstream)
    expect(sent.enable_thinking).toBe(false)
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "json" } })
    expect(sent.model).toBe("qwen3.8-max")
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success" })
  })

  test("forced tool + model NOT in set: no enable_thinking field", async () => {
    const { app, upstream, usage } = wire([qwen()], ["qwen3.8-flash"])

    const res = await app.request("/v1/messages", post(forcedBody("qwen3.8-max"), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect("enable_thinking" in sentBody(upstream)).toBe(false)
    expect(usage.rows).toHaveLength(1)
  })

  test("empty config set: never injected even for a forced tool", async () => {
    const { app, upstream } = wire([qwen()], [])

    const res = await app.request("/v1/messages", post(forcedBody("qwen3.8-max"), bearer()))
    await res.text()
    await settle()

    expect("enable_thinking" in sentBody(upstream)).toBe(false)
  })

  test("non-forced tool_choice (auto) + in-set model: no field", async () => {
    const { app, upstream } = wire([qwen()], ["qwen3.8-max"])
    const body = JSON.parse(forcedBody("qwen3.8-max")) as Record<string, unknown>
    body.tool_choice = { type: "auto" }

    const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
    await res.text()
    await settle()

    expect("enable_thinking" in sentBody(upstream)).toBe(false)
  })
})

describe("openai-responses egress is never touched", () => {
  const RESPONSES_REPLY = new Response(
    [
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", content_index: 0, delta: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "m", content_index: 0, text: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } } })}\n\n`,
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

  test("in-set model on a Responses target gets no enable_thinking field (egress gate)", async () => {
    const upstream = mockUpstream([() => RESPONSES_REPLY.clone()])
    const usage = usageSink()
    const health = createHealthStore({ jitter: () => 0 })
    const testClock = clock()
    const metrics = createMetrics({ now: testClock.now })
    const store = catalog(
      [
        account("resp", {
          provider: "openai-api",
          dialect: "openai-responses",
          apiKey: "sk-r",
          cipher: CRYPTOR,
        }),
      ],
      [],
    )
    const verifier = createRouterKeyVerifier({
      repository: keyRepository([apiKeyRow(KEY, CRYPTOR, { scope: "all" })]),
      cipher: CRYPTOR,
      loadScope: async () => ({ kind: "all" }),
    })
    const app = new Hono<AppEnv>()
    const logger = createLogger({ level: "error", write: () => undefined })
    app.use("*", requestId())
    app.use("*", requestLogger(logger))
    app.onError(errorHandler(logger))
    app.notFound(notFoundHandler())
    app.route(
      "/",
      dataPlaneRoutes({
        verifier,
        catalog: store,
        health,
        now: testClock.now,
        dispatcher: createDispatcher({
          catalog: store,
          health,
          cipher: CRYPTOR,
          usage,
          fetch: upstream.fetch,
          clock: testClock,
          onRequest: (sample) => metrics.observeRequest(sample),
          options: {
            failover: { maxAttempts: 3 },
            translation: {
              // The egress model id is in the set, so only the openai-chat gate keeps the dial off.
              thinkingDefaultModels: createThinkingDefaultMatcher(["qwen3.8-max", "gpt-5.5"]),
            },
          },
        }),
      }),
    )

    const body = JSON.parse(forcedBody("gpt-5.5")) as Record<string, unknown>
    body.stream = true
    const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
    await res.text()
    await settle()

    expect("enable_thinking" in sentBody(upstream)).toBe(false)
  })
})
