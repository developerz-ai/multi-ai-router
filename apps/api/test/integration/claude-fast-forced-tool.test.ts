import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * #370: Claude subscriptions on the fast transport. Anthropic refuses a forced tool choice for
 * claude-opus-5-5 and claude-sonnet-5-5 (prod replay 2026-11-09), so fast mode adapts it, carries
 * `response_format` as native `output_config.format`, and answers a refusal with `error.router`.
 */

const TOKEN = "fast-selected-account-token"
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`
const answer = '{"ok":true}'
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
const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}

function fastRouter(upstream: () => Response) {
  const sent: Record<string, unknown>[] = []
  const lines: Record<string, unknown>[] = []
  const invokeSdk = createFastInvoker({
    concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
    errorMaxBytes: 4096,
    credential: async () => ({
      accessToken: TOKEN,
      expiresAt: Date.now() + 3_600_000,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    resolveModel: (_, model) => model,
    sdk: async () => new Response("unexpected SDK fallback", { status: 500 }),
    fetch: async (request) => {
      sent.push(JSON.parse(await request.text()))
      return upstream()
    },
  })
  const { app, usage } = harness({
    accounts: [subscriptionAccount("sub")],
    responses: [],
    maxAttempts: 1,
    invokeSdk,
    logger: createLogger({
      level: "warn",
      write: (line) => {
        lines.push(JSON.parse(line))
      },
    }),
  })
  return { app, usage, sent, lines }
}

const sse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } })

function chatWithResponseFormat(stream: boolean): string {
  return JSON.stringify({
    model: "claude-opus-5-5",
    stream,
    messages: [{ role: "user", content: "answer ok" }],
    response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
  })
}

describe("openai-chat response_format on a fast-mode Claude subscription", () => {
  test("forwards native output_config.format and returns the JSON as message.content", async () => {
    const h = fastRouter(() => sse(textWire))
    const response = await h.app.request(
      "/v1/chat/completions",
      post(chatWithResponseFormat(false), bearer()),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      choices: {
        message: { content: string | null; tool_calls?: unknown }
        finish_reason: string
      }[]
    }
    expect(body.choices[0]?.message.content).toBe(answer)
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
    expect(body.choices[0]?.finish_reason).toBe("stop")
    const forwarded = h.sent[0]
    expect(forwarded?.output_config).toEqual({ format: { type: "json_schema", schema } })
    expect(forwarded?.tools).toEqual([])
    expect(forwarded).not.toHaveProperty("tool_choice")
    expect(forwarded).not.toHaveProperty("thinking")
  })

  test("streams the JSON as content deltas and finishes with stop", async () => {
    const h = fastRouter(() => sse(textWire))
    const response = await h.app.request(
      "/v1/chat/completions",
      post(chatWithResponseFormat(true), bearer()),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    let content = ""
    const finishes: string[] = []
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const chunk = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string; tool_calls?: unknown }; finish_reason?: string }[]
      }
      const choice = chunk.choices?.[0]
      expect(choice?.delta?.tool_calls).toBeUndefined()
      content += choice?.delta?.content ?? ""
      if (choice?.finish_reason) finishes.push(choice.finish_reason)
    }
    expect(content).toBe(answer)
    expect(finishes).toEqual(["stop"])
    expect(h.sent[0]?.output_config).toEqual({ format: { type: "json_schema", schema } })
  })
})

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

function chatWithJsonObject(stream: boolean): string {
  return JSON.stringify({
    model: "claude-opus-5-5",
    stream,
    messages: [{ role: "user", content: "answer ok" }],
    response_format: { type: "json_object" },
  })
}

describe("openai-chat json_object on a fast-mode Claude subscription", () => {
  // Anthropic refuses `output_config.format` {type:"object"}: "For 'object' type,
  // 'additionalProperties' must be explicitly set to false" (local router vs a real subscription,
  // 2026-11-09). So json_object rides the adapted forced tool instead.
  test("sends the adapted tool, not output_config, and returns the tool input as content", async () => {
    const h = fastRouter(() => sse(toolWire))
    const response = await h.app.request(
      "/v1/chat/completions",
      post(chatWithJsonObject(false), bearer()),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      choices: {
        message: { content: string | null; tool_calls?: unknown }
        finish_reason: string
      }[]
    }
    expect(JSON.parse(body.choices[0]?.message.content ?? "null")).toEqual(JSON.parse(answer))
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
    expect(body.choices[0]?.finish_reason).toBe("stop")
    const forwarded = h.sent[0]
    expect(forwarded).not.toHaveProperty("output_config")
    expect(forwarded?.tool_choice).toEqual({ type: "auto" })
    expect(forwarded?.tools).toMatchObject([{ name: "router_structured_output" }])
    expect(forwarded).not.toHaveProperty("thinking")
  })

  test("streams the tool input as content and finishes with stop", async () => {
    const h = fastRouter(() => sse(toolWire))
    const response = await h.app.request(
      "/v1/chat/completions",
      post(chatWithJsonObject(true), bearer()),
    )
    expect(response.status).toBe(200)
    let content = ""
    const finishes: string[] = []
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const chunk = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string; tool_calls?: unknown }; finish_reason?: string }[]
      }
      const choice = chunk.choices?.[0]
      expect(choice?.delta?.tool_calls).toBeUndefined()
      content += choice?.delta?.content ?? ""
      if (choice?.finish_reason) finishes.push(choice.finish_reason)
    }
    expect(JSON.parse(content)).toEqual(JSON.parse(answer))
    expect(finishes).toEqual(["stop"])
    expect(h.sent[0]).not.toHaveProperty("output_config")
  })

  test("a nonstream answer in plain text fails as forced-tool-unmet", async () => {
    const h = fastRouter(() => sse(textWire))
    const response = await h.app.request(
      "/v1/chat/completions",
      post(chatWithJsonObject(false), bearer()),
    )
    await settle()
    expect(response.status).toBe(502)
    const line = h.lines.find((entry) => entry.msg === "upstream attempt failed")
    expect(line?.signal).toBe("claude-sdk:forced-tool-unmet")
  })
})

describe("a fast-mode upstream refusal", () => {
  const said = `tool_choice forced is not supported for this model (account ${TOKEN})`
  const refusal = () =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: said } }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
  const forcedMessages = JSON.stringify({
    model: "claude-opus-5-5",
    max_tokens: 64,
    tools: [{ name: "weather", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "missing" },
    messages: [{ role: "user", content: "hello" }],
  })

  test("reaches an anthropic client with error.router wall request, and the log with its words", async () => {
    const h = fastRouter(refusal)
    const response = await h.app.request("/v1/messages", post(forcedMessages, bearer()))
    await settle()
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain("tool_choice forced is not supported")
    expect(text).not.toContain(TOKEN)
    const body = JSON.parse(text) as {
      error: { message: string; router?: { wall: string; signal: string | null; attempts: number } }
    }
    expect(body.error.message).toBe("the upstream rejected the request as malformed")
    expect(body.error.router).toMatchObject({
      wall: "request",
      retryable: false,
      signal: "claude-sdk:api-status-400",
      attempts: 1,
    })
    const line = h.lines.find((entry) => entry.msg === "upstream attempt failed")
    expect(line?.signal).toBe("claude-sdk:api-status-400")
    expect(String(line?.upstreamMessage)).toContain("tool_choice forced is not supported")
    expect(JSON.stringify(h.lines)).not.toContain(TOKEN)
    expect(h.usage.rows).toHaveLength(1)
  })

  test("reaches an openai-chat client with error.router wall request", async () => {
    const h = fastRouter(refusal)
    const response = await h.app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model: "claude-opus-5-5",
          messages: [{ role: "user", content: "hello" }],
        }),
        bearer(),
      ),
    )
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain("tool_choice forced is not supported")
    expect(text).not.toContain(TOKEN)
    const body = JSON.parse(text) as { error: { router?: { wall: string } } }
    expect(body.error.router?.wall).toBe("request")
  })

  test("a nonstream forced turn that answers in text fails as forced-tool-unmet", async () => {
    const h = fastRouter(() => sse(textWire))
    const response = await h.app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          tools: [{ name: "weather", input_schema: { type: "object" } }],
          tool_choice: { type: "tool", name: "weather" },
          messages: [{ role: "user", content: "hello" }],
        }),
        bearer(),
      ),
    )
    await settle()
    expect(response.status).toBe(502)
    expect(await response.text()).toContain(
      "the turn ended without the tool call the request's tool_choice forced",
    )
    const line = h.lines.find((entry) => entry.msg === "upstream attempt failed")
    expect(line?.signal).toBe("claude-sdk:forced-tool-unmet")
  })
})
