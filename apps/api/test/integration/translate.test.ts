import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import type { PoolSnapshot } from "../../src/services/routing"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

/**
 * The `translate` egress mode end to end: an Anthropic client dispatched to an openai-chat
 * account, streaming intact. `dataplane.test.ts` covers the non-streaming direction (M6a/M6b's
 * first landing); this file is the streaming half plus the error and usage guarantees that only
 * show up once bytes are actually flowing incrementally through a translator.
 *
 * Nothing here touches a network: `fetch` is `harness()`'s mocked upstream, same as every other
 * integration suite in this directory.
 */

function openRouterAccount(id = "or-1", overrides: Parameters<typeof account>[1] = {}) {
  return account(id, { provider: "openrouter", apiKey: "sk-or", cipher: CRYPTOR, ...overrides })
}

function openAiChunk(body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o", ...body })}\n\n`
}

const DONE = "data: [DONE]\n\n"

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  return out
}

describe("cross-dialect streaming (translate egress)", () => {
  test("an anthropic request against an openai-chat account comes back as Anthropic SSE with stop_reason and usage", async () => {
    const body =
      openAiChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openAiChunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } }) +
      DONE
    const slow = slowStream([body])
    const { app, upstream, usage } = harness({
      accounts: [openRouterAccount()],
      responses: [() => slow.response],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    slow.release(0)
    slow.finish()
    const text = await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    // Addressed at the account's dialect, at the account's dialect's path.
    expect(upstream.calls[0]?.url).toContain("/chat/completions")
    // Anthropic's own event names and shape — never the openai-chat ones the account spoke.
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: message_delta")
    expect(text).toContain("event: message_stop")
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain('"output_tokens":22')
    expect(text).toContain('"input_tokens":11')

    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "success" })
    expect(usage.rows[0]?.tokensIn).toBeGreaterThan(0)
    expect(usage.rows[0]?.tokensOut).toBeGreaterThan(0)
  })

  /**
   * The shape vLLM, SGLang, Fireworks and Together emit for parallel calls — both announced in one
   * chunk, arguments streamed per index afterwards — on the bytes a client actually reads. A reader
   * keeping only the block it opened last hands back `get_weather` with an empty `input` under
   * `"stop_reason":"tool_use"`, which no client can tell from a model that meant it.
   */
  test("parallel tool calls arrive whole when the upstream revisits an earlier index", async () => {
    const call = (index: number, args: string, named?: Record<string, unknown>) => ({
      index,
      ...named,
      function: { ...(named?.name === undefined ? {} : { name: named.name }), arguments: args },
    })
    const body =
      openAiChunk({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                call(0, "", { id: "call_1", name: "get_weather" }),
                call(1, "", { id: "call_2", name: "lookup" }),
              ],
            },
          },
        ],
      }) +
      openAiChunk({ choices: [{ index: 0, delta: { tool_calls: [call(0, '{"city":"NY"}')] } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: { tool_calls: [call(1, '{"q":"x"}')] } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      DONE
    const slow = slowStream([body])
    const { app } = harness({ accounts: [openRouterAccount()], responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    slow.release(0)
    slow.finish()
    const text = await res.text()
    await settle()

    expect(text).toContain('"name":"get_weather"')
    expect(text).toContain('"name":"lookup"')
    expect(text).toContain('"partial_json":"{\\"city\\":\\"NY\\"}"')
    expect(text).toContain('"partial_json":"{\\"q\\":\\"x\\"}"')
    expect(text).toContain('"stop_reason":"tool_use"')
    // One open block at a time: every start is closed before the next one opens.
    const boundaries = [...text.matchAll(/event: content_block_(start|stop)/g)].map((hit) => hit[1])
    expect(boundaries).toEqual(["start", "stop", "start", "stop"])
  })

  test("streams without buffering: the first translated event reaches the client before the upstream sends its next chunk", async () => {
    const first = openAiChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }],
    })
    const second = openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + DONE
    const slow = slowStream([first, second])
    const { app } = harness({ accounts: [openRouterAccount()], responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    const early = new TextDecoder().decode((await reader.read()).value)
    // The first upstream chunk's own content reached the client...
    expect(early).toContain("event: message_start")
    expect(early).toContain('"text_delta"')
    // ...while the second upstream chunk is still gated. A relay that buffered the whole response
    // before writing anything would have nothing to hand back here at all — `reader.read()` above
    // would still be pending on the still-unreleased second chunk instead of resolving now.
    expect(early).not.toContain("message_stop")

    slow.release(1)
    slow.finish()
    const rest = await drain(reader)
    expect(rest).toContain("event: message_stop")
  })

  /** An Anthropic frame off the wire: `event:` named, `type` repeated inside the payload. */
  function anthropicChunk(type: string, payload: Record<string, unknown> = {}): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  }

  const RESPONSES_BODY = JSON.stringify({
    model: "claude-opus-5",
    input: [{ role: "user", content: "what's the weather in NY?" }],
    tools: [
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  })

  test("a /v1/responses request against an anthropic account comes back as Responses SSE", async () => {
    const body =
      anthropicChunk("message_start", {
        message: { id: "msg_01", model: "claude-opus-5", usage: { input_tokens: 12 } },
      }) +
      anthropicChunk("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      }) +
      anthropicChunk("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":"NY"}' },
      }) +
      anthropicChunk("content_block_stop", { index: 0 }) +
      anthropicChunk("message_delta", {
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 8 },
      }) +
      anthropicChunk("message_stop")
    const slow = slowStream([body])
    const { app, upstream } = harness({ responses: [() => slow.response] })

    const res = await app.request(
      "/v1/responses",
      post(JSON.stringify({ ...JSON.parse(RESPONSES_BODY), stream: true }), bearer()),
    )
    slow.release(0)
    slow.finish()
    const text = await res.text()
    await settle()

    expect(res.status).toBe(200)
    // Addressed at the account's own dialect, anthropic, never the Responses shape the client spoke.
    expect(upstream.calls[0]?.url).toContain("/v1/messages")
    expect(text).toContain("event: response.created")
    expect(text).toContain("event: response.output_item.added")
    expect(text).toContain('"type":"function_call"')
    expect(text).toContain('"name":"get_weather"')
    expect(text).toContain('"arguments":"{\\"city\\":\\"NY\\"}"')
    expect(text).toContain("event: response.output_item.done")
    expect(text).toContain("event: response.completed")
  })

  test("a non-streaming /v1/responses request against an anthropic account round-trips the tool call", async () => {
    const { app, upstream } = harness({
      responses: [
        () =>
          jsonResponse(200, {
            id: "msg_01",
            model: "claude-opus-5",
            content: [
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NY" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 12, output_tokens: 8 },
          }),
      ],
    })

    const res = await app.request("/v1/responses", post(RESPONSES_BODY, bearer()))
    const parsed = (await res.json()) as {
      status: string
      output: { type: string; name?: string; arguments?: string }[]
    }
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls[0]?.url).toContain("/v1/messages")
    expect(parsed.status).toBe("completed")
    expect(parsed.output).toEqual([
      {
        type: "function_call",
        id: expect.any(String),
        call_id: "toolu_1",
        name: "get_weather",
        arguments: '{"city":"NY"}',
        status: "completed",
      },
    ])
  })

  test("an upstream error from a translated account renders in the client's own dialect and names no account", async () => {
    const { app, upstream } = harness({
      accounts: [openRouterAccount("secret-account-id", { apiKey: "sk-shh" })],
      responses: [
        () =>
          jsonResponse(400, {
            error: {
              message: "temperature must be between 0 and 2",
              type: "invalid_request_error",
              code: "400",
            },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const body = (await res.json()) as Record<string, unknown>
    const rendered = JSON.stringify(body)

    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toBe("application/json")
    // Anthropic's error shape — the client asked `/v1/messages`, even though the account behind it
    // spoke openai-chat and answered in that shape.
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } })
    expect(rendered).toContain("temperature must be between 0 and 2")
    // The account's identity and credential never reach the client, translated or not.
    expect(rendered).not.toContain("secret-account-id")
    expect(rendered).not.toContain("sk-shh")
    expect(upstream.calls).toHaveLength(1)
  })
})

/**
 * The output ceiling is one field with two names, and no upstream accepts both. OpenAI renamed
 * `max_tokens` to `max_completion_tokens` and refuses the old one on every reasoning model it
 * sells; five of the compatible vendors here have never heard of the new one, and the ones that
 * merely ignore it generate unbounded instead of answering an error anybody can see.
 *
 * So the name is the **account's**, resolved per candidate like the model is
 * (docs/idea/06-protocol-translation.md#known-lossy-edges). These are the assertions that say the
 * caller's ceiling survives the conversion, whichever account answers.
 */
/**
 * The request a current Claude Code sends, end to end against an openai-chat account. Production
 * counted 213 `translation_failed` 400s in one week from exactly this shape; the unit half is
 * `test/unit/translate/claude-code-shape.test.ts`, this is the wire: the request is served, the
 * upstream gets a body it can read, and the operator gets one line naming what was left out.
 */
describe("a Claude Code turn on translate egress", () => {
  const CLAUDE_CODE = JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 32_000,
    system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
    metadata: { user_id: '{"device_id":"d"}' },
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "xhigh" },
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        name: "Read",
        description: "Reads a file",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ],
    tool_choice: { type: "auto", disable_parallel_tool_use: false },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look at the screenshot" },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ok", signature: "sig" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.png" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
        ],
      },
    ],
  })

  function capturing() {
    const lines: Record<string, unknown>[] = []
    const logger = createLogger({
      level: "debug",
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    })
    return { logger, lines }
  }

  test("is served, the upstream gets only what it can read, and one warn line names the rest", async () => {
    const { logger, lines } = capturing()
    const { app, upstream, usage } = harness({
      accounts: [openRouterAccount("or-1", { apiKey: "sk-or-secret-value-1234567890" })],
      responses: [
        () =>
          jsonResponse(200, {
            id: "chatcmpl-1",
            model: "gpt-4o",
            choices: [{ index: 0, message: { role: "assistant", content: "a cat" } }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
      ],
      logger,
    })

    const res = await app.request("/v1/messages", post(CLAUDE_CODE, bearer()))
    const body = (await res.json()) as Record<string, unknown>
    await settle()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ type: "message", role: "assistant" })

    const sent = JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
    const tools = sent.tools as { function: { name: string } }[]
    expect(tools.map((tool) => tool.function.name)).toEqual(["Read"])
    expect(JSON.stringify(sent)).not.toMatch(/web_search|tool_search|JVBERi0=|"sig"|thinking/)
    // The screenshot reached the model, hoisted out of the text-only tool message.
    expect(JSON.stringify(sent)).toContain("data:image/png;base64,AAAA")

    const line = lines.find((entry) => entry.msg === "translation dropped fields")
    expect(line).toBeDefined()
    expect(line?.level).toBe("warn")
    expect(line?.egress).toBe("openai-chat")
    expect(line?.dropped).toBe(3)
    expect(JSON.stringify(line?.fields)).toMatch(/tools\[0\].*web_search_20260209/)
    expect(JSON.stringify(line?.fields)).toContain("messages[0].content[1]")
    // Nothing about the account — and nothing from the body's values — reaches the line.
    expect(JSON.stringify(lines)).not.toContain("sk-or-secret-value-1234567890")
    expect(JSON.stringify(lines)).not.toContain("You are Claude Code")

    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "success" })
  })

  test("a refused request logs the field it refused on the request-failed line", async () => {
    const { logger, lines } = capturing()
    const { app } = harness({
      accounts: [openRouterAccount()],
      responses: [() => jsonResponse(200, {})],
      logger,
    })
    const noMessages = JSON.stringify({ model: "claude-opus-5", max_tokens: 8 })

    const res = await app.request("/v1/messages", post(noMessages, bearer()))

    expect(res.status).toBe(400)
    const line = lines.find((entry) => entry.msg === "request failed")
    expect(line?.errorCode).toBe("translation_failed")
    expect(String(line?.error)).toContain("messages")
  })

  test("an upstream keepalive comment reaches the client before the first event, as a comment", async () => {
    const first = ": OPENROUTER PROCESSING\n\n"
    const second =
      openAiChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      DONE
    const slow = slowStream([first, second])
    const { app } = harness({ accounts: [openRouterAccount()], responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    const early = new TextDecoder().decode((await reader.read()).value)
    // The keepalive went out on its own, while the upstream had said nothing else yet.
    expect(early).toBe(": OPENROUTER PROCESSING\n\n")

    slow.release(1)
    slow.finish()
    const rest = await drain(reader)
    expect(rest).toContain("event: message_start")
    expect(rest).toContain("event: message_stop")
  })
})

describe("the openai-chat output ceiling (translate egress)", () => {
  const CEILING_POOL_ID = "ceiling-pool"

  /** Priority order, so the failover walk below is the chain the test says it is. */
  const ceilingPool = (): PoolSnapshot => ({
    id: CEILING_POOL_ID,
    name: "ceiling",
    policy: "priority-failover",
    members: [
      { accountId: "oa", priority: 0 },
      { accountId: "or-1", priority: 1 },
    ],
  })

  const openAiAccount = (id = "oa") =>
    account(id, { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })

  const ok = () => jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 2 } })

  function sent(body: string | undefined): Record<string, unknown> {
    return JSON.parse(body ?? "{}") as Record<string, unknown>
  }

  test("an openai-api account is sent max_completion_tokens, and never the name it refuses", async () => {
    const { app, upstream } = harness({ accounts: [openAiAccount()], responses: [ok] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    const body = sent(upstream.calls[0]?.body)
    // 64 is `MESSAGE`'s own `max_tokens` — the caller's ceiling, under the target's name for it.
    expect(body.max_completion_tokens).toBe(64)
    expect(body).not.toHaveProperty("max_tokens")
  })

  test("every other openai-chat vendor keeps max_tokens: the new name would drop the ceiling silently", async () => {
    const { app, upstream } = harness({ accounts: [openRouterAccount()], responses: [ok] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    const body = sent(upstream.calls[0]?.body)
    expect(body.max_tokens).toBe(64)
    expect(body).not.toHaveProperty("max_completion_tokens")
  })

  test("a failover between two openai-chat accounts converts twice: each gets the name it reads", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openAiAccount(), openRouterAccount()],
      pools: [ceilingPool()],
      scope: "pools",
      poolIds: [CEILING_POOL_ID],
      // The openai-api account's turn: a plain 429 is retryable, so the chain walks on.
      responses: [() => jsonResponse(429, {}), ok],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    // The conversion is cached per target *shape*, not per target dialect. Cached by dialect alone,
    // the second account would be handed the first account's body — a field OpenRouter's upstream
    // model may never see, and no ceiling at all under the name it does read.
    expect(sent(upstream.calls[0]?.body).max_completion_tokens).toBe(64)
    expect(sent(upstream.calls[0]?.body)).not.toHaveProperty("max_tokens")
    expect(sent(upstream.calls[1]?.body).max_tokens).toBe(64)
    expect(sent(upstream.calls[1]?.body)).not.toHaveProperty("max_completion_tokens")
    expect(usage.rows.map((row) => row.accountId)).toEqual(["oa", "or-1"])
  })

  test("two accounts that agree are handed the same bytes: the ceiling adds no per-attempt drift", async () => {
    const { app, upstream } = harness({
      accounts: [openRouterAccount("or-1"), openRouterAccount("or-2")],
      pools: [
        {
          ...ceilingPool(),
          members: [
            { accountId: "or-1", priority: 0 },
            { accountId: "or-2", priority: 1 },
          ],
        },
      ],
      scope: "pools",
      poolIds: [CEILING_POOL_ID],
      responses: [() => jsonResponse(429, {}), ok],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.body).toBe(upstream.calls[1]?.body ?? "")
  })
})

/**
 * Structured output end to end: the refusal a *client library* is the one that notices.
 *
 * An OpenAI SDK `.parse()`, LangChain's `withStructuredOutput()`, Instructor, and `generateObject`
 * all send `response_format` and then parse the reply as the schema they sent. Dropped in
 * translation the call succeeds, prose comes back, and the failure lands at the caller's own
 * `JSON.parse` with nothing on the wire naming the cause. These assert the `400` arrives instead —
 * **before a socket is opened**, in the client's own dialect, naming the field to remove.
 */
describe("response_format on translate egress (the structured-output contract)", () => {
  const CHAT = (responseFormat: unknown) =>
    JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "who won?" }],
      response_format: responseFormat,
    })

  const ok = () =>
    jsonResponse(200, {
      id: "msg_01",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    })

  test("a json_schema request is refused 400 naming the field, and no upstream is called", async () => {
    // An anthropic-dialect account: openai-chat ingress, so the body goes through a translator.
    const { app, upstream, usage } = harness({ responses: [ok] })

    const res = await app.request(
      "/v1/chat/completions",
      post(CHAT({ type: "json_schema", json_schema: { name: "winner", strict: true } }), bearer()),
    )
    const body = (await res.json()) as { error?: { type?: string; message?: string } }
    await settle()

    expect(res.status).toBe(400)
    // The client's own dialect, since openai-chat is what it spoke.
    expect(body.error?.type).toBe("invalid_request_error")
    expect(body.error?.message).toContain("response_format.type")
    expect(upstream.calls).toHaveLength(0)
    // The schema the caller sent is never quoted back — `shared/reject.ts` interpolates no value
    // out of a body it refused, and this one is a client-facing surface.
    expect(body.error?.message).not.toContain("winner")
    // A refused request is still a request: one row, priced at nothing, named a client error.
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "client_error", tokensIn: 0, tokensOut: 0 })
  })

  test("response_format: text is served: it is the default and constrains nothing", async () => {
    const { app, upstream } = harness({ responses: [ok] })

    const res = await app.request("/v1/chat/completions", post(CHAT({ type: "text" }), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
  })
})
