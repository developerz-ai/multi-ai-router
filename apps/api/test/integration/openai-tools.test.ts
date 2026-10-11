import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Tool-calling requests through both OpenAI drivers, end to end, against mocked upstreams.
 *
 * The Codex / Responses integration tests in `codex-translate.test.ts` cover text-only traffic;
 * these tests pin what production must reach on the tool-calling path the GPT-6 models will use
 * (`/v1/messages` → `openai-oauth` account, plus `openai-api` accounts pinned to `openai-responses`).
 * No real provider is reached; the upstream is a script that returns canned Responses SSE bytes
 * (the openai-responses dialect always streams, and the response translator reads SSE).
 *
 * Each non-stream case is repeated as a stream case, so a translator that swallows stream data on
 * one dialect is the only way the case fails. Reasoning shape is also exercised twice — once with
 * no reasoning field, once with `thinking: {type: "adaptive"}` and `output_config: {effort: "low"}`
 * — so the `reasoning` key the Responses API requires is asserted on both sides.
 */

const ACCOUNT_ID = "acct-codex-789"
const OPENAI_API_KEY = "sk-openai-api-test-key"

function codexAccount() {
  return {
    ...account("codex", { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
    authMaterial: CRYPTOR.encrypt(
      JSON.stringify({
        accessToken: `eyJhbGciOiJub25lIn0.${Buffer.from(
          JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
        ).toString("base64url")}.sig`,
      }),
    ),
  }
}

function openaiApiResponsesAccount() {
  return account("oai-api", {
    provider: "openai-api",
    cipher: CRYPTOR,
    apiKey: OPENAI_API_KEY,
    dialect: "openai-responses",
    billing: "metered",
  })
}

function frame(type: string, fields: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

/**
 * A Responses SSE stream carrying exactly one `function_call` item. `CODEX_RESPONSES_EGRESS` forces
 * the openai-oauth egress to stream even when the client asked otherwise, so every openai-responses
 * leg returns this shape — the response translator's stream reader picks it up and the dispatcher
 * collects it back into one Anthropic JSON message for a non-streaming client.
 */
function responsesCallStream(call: {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}): Response {
  const body = [
    frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: call.callId,
        call_id: call.callId,
        name: call.name,
        arguments: "",
        status: "in_progress",
      },
    }),
    frame("response.function_call_arguments.delta", {
      item_id: call.callId,
      output_index: 0,
      delta: call.arguments,
    }),
    frame("response.function_call_arguments.done", {
      item_id: call.callId,
      output_index: 0,
      arguments: call.arguments,
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: call.callId,
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
        status: "completed",
      },
    }),
    frame("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: { input_tokens: 24, output_tokens: 11, total_tokens: 35 },
      },
    }),
  ].join("")
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** Two function_calls in one stream — the parallel-calls leg. */
function responsesParallelCallsStream(
  calls: ReadonlyArray<{
    readonly callId: string
    readonly name: string
    readonly arguments: string
  }>,
): Response {
  const body: string[] = [
    frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
  ]
  for (const [index, call] of calls.entries()) {
    body.push(
      frame("response.output_item.added", {
        output_index: index,
        item: {
          type: "function_call",
          id: call.callId,
          call_id: call.callId,
          name: call.name,
          arguments: "",
          status: "in_progress",
        },
      }),
      frame("response.function_call_arguments.delta", {
        item_id: call.callId,
        output_index: index,
        delta: call.arguments,
      }),
      frame("response.function_call_arguments.done", {
        item_id: call.callId,
        output_index: index,
        arguments: call.arguments,
      }),
      frame("response.output_item.done", {
        output_index: index,
        item: {
          type: "function_call",
          id: call.callId,
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
          status: "completed",
        },
      }),
    )
  }
  body.push(
    frame("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: { input_tokens: 30, output_tokens: 22, total_tokens: 52 },
      },
    }),
  )
  return new Response(body.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function responsesTextStream(text: string): Response {
  const body = [
    frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    }),
    frame("response.content_part.added", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    frame("response.output_text.delta", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    frame("response.output_text.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text,
    }),
    frame("response.content_part.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
    frame("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: { input_tokens: 18, output_tokens: 6, total_tokens: 24 },
      },
    }),
  ].join("")
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const TOOL_DEF = {
  name: "get_weather",
  description: "Return the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
}

const MESSAGES_BODY = {
  model: "gpt-5.6-luna",
  max_tokens: 256,
  tools: [TOOL_DEF],
  messages: [{ role: "user", content: "Weather in Paris?" }],
}

function sentBody(upstream: {
  calls: readonly { body: string | null }[]
}): Record<string, unknown> {
  return JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
}

describe("openai-oauth: /v1/messages with a forced tool call", () => {
  test("non-stream — upstream body has tools, tool_choice {type:function,name}, no sampling fields, store:false; client receives tool_use + stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesCallStream({
            callId: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          tool_choice: { type: "tool", name: "get_weather" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as {
      content: ReadonlyArray<{ type: string; name?: string }>
      stop_reason: string
    }
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content).toHaveLength(1)
    const toolUse = body.content[0]!
    expect(toolUse.type).toBe("tool_use")
    expect(toolUse.name).toBe("get_weather")

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.url).toBe("https://upstream.test/responses")
    const sent = sentBody(upstream)
    expect(sent.store).toBe(false)
    expect(sent.stream).toBe(true)
    expect(typeof sent.instructions).toBe("string")
    expect("max_output_tokens" in sent).toBe(false)
    expect("temperature" in sent).toBe(false)
    expect("top_p" in sent).toBe(false)
    expect("reasoning_effort" in sent).toBe(false)
    expect(Array.isArray(sent.tools)).toBe(true)
    expect((sent.tools as ReadonlyArray<{ type: string; name?: string }>)[0]).toMatchObject({
      type: "function",
      name: "get_weather",
    })
    expect(sent.tool_choice).toEqual({ type: "function", name: "get_weather" })

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "translate",
      costBasis: "notional",
    })
  })

  test("stream — the client's Anthropic SSE carries content_block_start of type tool_use and message_delta with stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesCallStream({
            callId: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          stream: true,
          tool_choice: { type: "tool", name: "get_weather" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: content_block_start")
    expect(text).toMatch(/"type":"tool_use"/)
    expect(text).toContain("event: message_delta")
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(text).toContain("event: message_stop")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-oauth: /v1/messages with tool_choice any", () => {
  test("non-stream — upstream tool_choice is 'required' and the client sees a tool_use block", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () => responsesCallStream({ callId: "call_1", name: "get_weather", arguments: "{}" }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...MESSAGES_BODY, tool_choice: { type: "any" } }), bearer()),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stop_reason: string
      content: ReadonlyArray<{ type: string }>
    }
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content.some((b) => b.type === "tool_use")).toBe(true)

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })

  test("stream — same shape, message_delta carries tool_use", async () => {
    const { app, upstream } = harness({
      accounts: [codexAccount()],
      responses: [
        () => responsesCallStream({ callId: "call_1", name: "get_weather", arguments: "{}" }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({ ...MESSAGES_BODY, stream: true, tool_choice: { type: "any" } }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain('"stop_reason":"tool_use"')
  })
})

describe("openai-oauth: /v1/messages with a tool_result follow-up", () => {
  test("non-stream — upstream input carries a function_call_output, client receives a normal completion", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [() => responsesTextStream("It's 18°C in Paris.")],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          messages: [
            { role: "user", content: "Weather in Paris?" },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "call_1", content: '{"temperature_c":18}' },
              ],
            },
          ],
          tool_choice: { type: "tool", name: "get_weather" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: ReadonlyArray<{ type: string }> }
    expect(body.content.some((b) => b.type === "text")).toBe(true)

    const sent = sentBody(upstream)
    const input = sent.input as ReadonlyArray<{ type: string; call_id?: string; output?: string }>
    const outputItem = input.find((item) => item.type === "function_call_output")
    expect(outputItem).toBeDefined()
    expect(outputItem?.call_id).toBe("call_1")
    expect(outputItem?.output).toBe('{"temperature_c":18}')

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-oauth: /v1/messages with parallel tool calls", () => {
  test("non-stream — upstream returns two function_calls; client receives two tool_use blocks", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesParallelCallsStream([
            { callId: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
            { callId: "call_2", name: "get_weather", arguments: '{"city":"Tokyo"}' },
          ]),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          messages: [{ role: "user", content: "Weather in Paris and Tokyo?" }],
          tool_choice: { type: "any" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: ReadonlyArray<{ type: string; name?: string }> }
    const toolUses = body.content.filter((b) => b.type === "tool_use")
    expect(toolUses).toHaveLength(2)

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-oauth: /v1/messages reasoning shapes", () => {
  test("no reasoning field — upstream body has no `reasoning` key", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () => responsesCallStream({ callId: "call_1", name: "get_weather", arguments: "{}" }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({ ...MESSAGES_BODY, tool_choice: { type: "tool", name: "get_weather" } }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const sent = sentBody(upstream)
    expect("reasoning" in sent).toBe(false)
    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })

  test("adaptive thinking + effort low — upstream body carries reasoning {effort: low, summary: auto}", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () => responsesCallStream({ callId: "call_1", name: "get_weather", arguments: "{}" }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          tool_choice: { type: "tool", name: "get_weather" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const sent = sentBody(upstream)
    expect(sent.reasoning).toEqual({ effort: "low", summary: "auto" })
    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-api / openai-responses: /v1/messages with a forced tool call", () => {
  test("stream — upstream keeps sampling fields (no CODEX_RESPONSES_EGRESS); client sees tool_use + stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openaiApiResponsesAccount()],
      responses: [
        () =>
          responsesCallStream({
            callId: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          stream: true,
          tool_choice: { type: "tool", name: "get_weather" },
          temperature: 0.2,
          top_p: 0.9,
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(text).toMatch(/"type":"tool_use"/)

    expect(upstream.calls[0]?.url).toBe("https://upstream.test/responses")
    const sent = sentBody(upstream)
    // openai-api keeps the sampling fields — the CODEX_RESPONSES_EGRESS rule is Codex-only.
    expect(sent.temperature).toBe(0.2)
    expect(sent.top_p).toBe(0.9)
    expect(sent.tool_choice).toEqual({ type: "function", name: "get_weather" })

    await settle()
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "translate",
      costBasis: "metered",
    })
  })
})

describe("openai-api / openai-responses: /v1/messages with tool_choice any", () => {
  test("stream — upstream tool_choice is 'required' on the openai-api surface; client sees stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openaiApiResponsesAccount()],
      responses: [
        () => responsesCallStream({ callId: "call_1", name: "get_weather", arguments: "{}" }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({ ...MESSAGES_BODY, stream: true, tool_choice: { type: "any" } }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"stop_reason":"tool_use"')

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "metered" })
  })
})

describe("/v1/chat/completions with tools into a Responses-speaking account", () => {
  test("openai-api / openai-responses — upstream tool_choice 'required' on the Responses egress", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openaiApiResponsesAccount()],
      responses: [
        () =>
          responsesCallStream({
            callId: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          }),
      ],
    })

    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model: "gpt-5.6-luna",
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Return the current weather for a city.",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
          tool_choice: "required",
          messages: [{ role: "user", content: "Weather in Paris?" }],
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    // The upstream speaks openai-responses, so its body is SSE regardless of how the chat
    // completions client asked to be served. We confirm the client receives the upstream's tool
    // call shape on the wire (translated to Anthropic-style events by the chat-completions path).
    const text = await res.text()
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text).toContain('"name":"get_weather"')

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "metered" })
  })
})
