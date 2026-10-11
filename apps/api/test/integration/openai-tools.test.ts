import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Tool-calling requests through both OpenAI drivers, end to end, against mocked upstreams.
 *
 * The Codex / Responses integration tests in `codex-translate.test.ts` cover text-only traffic;
 * these tests pin what production must reach on the tool-calling path the GPT-6 models will use
 * (`/v1/messages` → `openai-oauth` account, plus `openai-api` accounts pinned to `openai-responses`).
 * No real provider is reached; the upstream is a script that returns canned Responses bytes (SSE, and JSON for one chat case)
 * (the openai-oauth egress forces a stream; openai-api may return JSON or SSE) and the response
 * translator reads whichever shape arrives.
 *
 * Every primary case (forced tool, tool_choice any, tool-result follow-up, parallel tool calls) is
 * exercised in both a non-stream and a stream variant, so a translator that silently drops stream
 * data is the only way a case fails on the stream leg. Every primary case also runs in both
 * reasoning shapes — once with no reasoning field, once with `thinking: {type: "adaptive"}` and
 * `output_config: {effort: "low"}` — so the `reasoning` key the Responses API requires is asserted
 * on both sides, plus a non-streaming `/v1/chat/completions` JSON-reply case to pin the
 * `tool_calls` / `finish_reason` shape on the OpenAI Chat dialect translated through Responses.
 *
 * Fixture item ids (`fc_*`) differ from the call ids the upstream sends (`call_*`), so a
 * translator that keys the client `tool_use.id` off the item id rather than the `call_id` is
 * detected here. The `item_id` on every delta / done frame still names the item it belongs to
 * (`fc_*`), as `responses-item-identity.ts` expects.
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
 * One `function_call` item, encoded as a Responses SSE stream. The item's id (`itemId`) differs
 * from the call id the upstream sends (`callId`), so a translator that prefers the item id over
 * the call id when minting `tool_use.id` is exposed: the client must receive `callId`, not
 * `itemId`, as the `tool_use.id`. The `item_id` on every delta / done frame still names the
 * item (`itemId`) for `responses-item-identity.ts`.
 */
function responsesCallStream(call: {
  readonly itemId: string
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
        id: call.itemId,
        call_id: call.callId,
        name: call.name,
        arguments: "",
        status: "in_progress",
      },
    }),
    frame("response.function_call_arguments.delta", {
      item_id: call.itemId,
      output_index: 0,
      delta: call.arguments,
    }),
    frame("response.function_call_arguments.done", {
      item_id: call.itemId,
      output_index: 0,
      arguments: call.arguments,
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: call.itemId,
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

/** Two `function_call` items in one stream — the parallel-calls leg. */
function responsesParallelCallsStream(
  calls: ReadonlyArray<{
    readonly itemId: string
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
          id: call.itemId,
          call_id: call.callId,
          name: call.name,
          arguments: "",
          status: "in_progress",
        },
      }),
      frame("response.function_call_arguments.delta", {
        item_id: call.itemId,
        output_index: index,
        delta: call.arguments,
      }),
      frame("response.function_call_arguments.done", {
        item_id: call.itemId,
        output_index: index,
        arguments: call.arguments,
      }),
      frame("response.output_item.done", {
        output_index: index,
        item: {
          type: "function_call",
          id: call.itemId,
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

/** A non-streaming JSON Responses body with one `function_call` item. */
function responsesJsonFunctionCall(call: {
  readonly itemId: string
  readonly callId: string
  readonly name: string
  readonly arguments: string
}): Response {
  const body = JSON.stringify({
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-5.6-luna",
    output: [
      {
        type: "function_call",
        id: call.itemId,
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
        status: "completed",
      },
    ],
    usage: { input_tokens: 24, output_tokens: 11, total_tokens: 35 },
  })
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
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

/** Walk a chunked Anthropic SSE stream into a sequence of `(event, data)` pairs. */
function parseSseEvents(stream: string): { event: string; data: string }[] {
  const out: { event: string; data: string }[] = []
  const blocks = stream.split("\n\n")
  for (const block of blocks) {
    const trimmed = block.replace(/\s+$/, "")
    if (!trimmed) continue
    let event = ""
    let data = ""
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length)
      else if (line.startsWith("data: ")) data = line.slice("data: ".length)
    }
    if (event && data) out.push({ event, data })
  }
  return out
}

describe("openai-oauth: /v1/messages with a forced tool call", () => {
  test("non-stream — upstream body has tools, tool_choice {type:function,name}, no sampling fields, store:false; client receives tool_use + stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesCallStream({
            itemId: "fc_1",
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
          temperature: 0.2,
          top_p: 0.9,
          tool_choice: { type: "tool", name: "get_weather" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as {
      content: ReadonlyArray<{ type: string; id?: string; name?: string; input?: unknown }>
      stop_reason: string
    }
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content).toHaveLength(1)
    const toolUse = body.content[0]
    if (toolUse === undefined) throw new Error("expected one tool_use block")
    expect(toolUse.type).toBe("tool_use")
    expect(toolUse.id).toBe("call_1")
    expect(toolUse.name).toBe("get_weather")
    expect(toolUse.input).toEqual({ city: "Paris" })

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.url).toBe("https://upstream.test/responses")
    const sent = sentBody(upstream)
    expect(sent.store).toBe(false)
    expect(sent.stream).toBe(true)
    expect(typeof sent.instructions).toBe("string")
    expect("max_output_tokens" in sent).toBe(false)
    // The client sent temperature and top_p; CODEX_RESPONSES_EGRESS strips both on the way out.
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
            itemId: "fc_1",
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

    // Assert the streamed tool_use id is the upstream call_id, not the item id, and that the
    // accumulated input matches the parsed JSON arguments.
    const events = parseSseEvents(text)
    const toolUseStarts = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          JSON.parse(e.data) as {
            type: string
            index?: number
            content_block?: { type?: string; id?: string }
          },
      )
      .filter((p) => p.content_block?.type === "tool_use")
    expect(toolUseStarts).toHaveLength(1)
    expect(toolUseStarts[0]?.content_block?.id).toBe("call_1")

    // The input_json_delta frames belong to the tool_use block at the same index.
    const toolUseIndex = toolUseStarts[0]?.index
    const inputDeltas: string[] = []
    let stopSeen = false
    for (const e of events) {
      if (e.event === "content_block_stop") stopSeen = true
      const parsed = JSON.parse(e.data) as {
        type?: string
        index?: number
        delta?: { type?: string; partial_json?: string }
      }
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
        if (parsed.index === toolUseIndex && typeof parsed.delta.partial_json === "string") {
          inputDeltas.push(parsed.delta.partial_json)
        }
      }
    }
    expect(stopSeen).toBe(true)
    expect(inputDeltas.length).toBeGreaterThan(0)
    expect(JSON.parse(inputDeltas.join(""))).toEqual({ city: "Paris" })

    const sent = sentBody(upstream)
    expect((sent.tools as ReadonlyArray<{ type: string; name?: string }>)[0]).toMatchObject({
      type: "function",
      name: "get_weather",
    })
    expect(sent.tool_choice).toEqual({ type: "function", name: "get_weather" })

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-oauth: /v1/messages with tool_choice any", () => {
  test("non-stream — upstream tool_choice is 'required' and the client sees a tool_use block", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesCallStream({
            itemId: "fc_1",
            callId: "call_1",
            name: "get_weather",
            arguments: "{}",
          }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...MESSAGES_BODY, tool_choice: { type: "any" } }), bearer()),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      stop_reason: string
      content: ReadonlyArray<{ type: string; id?: string }>
    }
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content.some((b) => b.type === "tool_use")).toBe(true)

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })

  test("stream — content_block_start with tool_use, message_delta with stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesCallStream({
            itemId: "fc_1",
            callId: "call_1",
            name: "get_weather",
            arguments: "{}",
          }),
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
    const toolUseStart = parseSseEvents(text)
      .filter((e) => e.event === "content_block_start")
      .map((e) => JSON.parse(e.data) as { content_block?: { type?: string; id?: string } })
      .find((p) => p.content_block?.type === "tool_use")
    expect(toolUseStart?.content_block?.id).toBe("call_1")

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")
    expect((sent.tools as ReadonlyArray<{ name?: string }>)[0]?.name).toBe("get_weather")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
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
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: ReadonlyArray<{ type: string }> }
    expect(body.content.some((b) => b.type === "text")).toBe(true)

    const sent = sentBody(upstream)
    const input = sent.input as ReadonlyArray<{
      type: string
      call_id?: string
      name?: string
      arguments?: string
      output?: string
    }>
    const callItem = input.find((item) => item.type === "function_call")
    const outputItem = input.find((item) => item.type === "function_call_output")
    expect(callItem).toBeDefined()
    expect(callItem?.call_id).toBe("call_1")
    expect(callItem?.name).toBe("get_weather")
    expect(callItem?.arguments).toBe('{"city":"Paris"}')
    expect(outputItem).toBeDefined()
    expect(outputItem?.call_id).toBe("call_1")
    expect(outputItem?.output).toBe('{"temperature_c":18}')

    // The function_call item precedes the function_call_output in the upstream input — the order
    // mirrors the client's transcript (assistant tool_use, user tool_result).
    if (callItem === undefined || outputItem === undefined) {
      throw new Error(
        "expected both function_call and function_call_output items in upstream input",
      )
    }
    expect(input.indexOf(callItem)).toBeLessThan(input.indexOf(outputItem))

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })

  test("stream — same shape, the text reply is delivered through Anthropic SSE", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [() => responsesTextStream("It's 18°C in Paris.")],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          stream: true,
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
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: message_stop")
    expect(text).toContain("It's 18°C in Paris.")

    const sent = sentBody(upstream)
    expect(sent.stream).toBe(true)

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-oauth: /v1/messages with parallel tool calls", () => {
  test("non-stream — upstream returns two function_calls; client receives two tool_use blocks", async () => {
    const { app, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesParallelCallsStream([
            {
              itemId: "fc_1",
              callId: "call_1",
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
            {
              itemId: "fc_2",
              callId: "call_2",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
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
    const body = (await res.json()) as {
      content: ReadonlyArray<{ type: string; id?: string; name?: string; input?: unknown }>
    }
    const toolUses = body.content.filter((b) => b.type === "tool_use")
    expect(toolUses).toHaveLength(2)
    const ids = toolUses.map((b) => b.id).sort()
    expect(ids).toEqual(["call_1", "call_2"])
    const paris = toolUses.find((b) => b.input && JSON.stringify(b.input) === '{"city":"Paris"}')
    const tokyo = toolUses.find((b) => b.input && JSON.stringify(b.input) === '{"city":"Tokyo"}')
    expect(paris?.id).toBe("call_1")
    expect(tokyo?.id).toBe("call_2")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })

  test("stream — two content_block_start tool_use frames with distinct ids and per-block input_json_delta", async () => {
    const { app, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () =>
          responsesParallelCallsStream([
            {
              itemId: "fc_1",
              callId: "call_1",
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
            {
              itemId: "fc_2",
              callId: "call_2",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ]),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          ...MESSAGES_BODY,
          stream: true,
          messages: [{ role: "user", content: "Weather in Paris and Tokyo?" }],
          tool_choice: { type: "any" },
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    const events = parseSseEvents(text)

    const toolUseStarts = events
      .filter((e) => e.event === "content_block_start")
      .map(
        (e) =>
          JSON.parse(e.data) as {
            type: string
            index?: number
            content_block?: { type?: string; id?: string }
          },
      )
      .filter((p) => p.content_block?.type === "tool_use")
      .map((p) => ({ id: p.content_block?.id, index: p.index }))
    expect(toolUseStarts).toHaveLength(2)
    const ids = toolUseStarts.map((p) => p.id).sort()
    expect(ids).toEqual(["call_1", "call_2"])

    // Per-block input_json_delta correctness: the deltas for each call land on that call only.
    const deltasById = new Map<string, string[]>()
    for (const e of events) {
      const parsed = JSON.parse(e.data) as {
        type?: string
        index?: number
        delta?: { type?: string; partial_json?: string }
      }
      if (parsed.type !== "content_block_delta") continue
      if (parsed.delta?.type !== "input_json_delta") continue
      if (typeof parsed.index !== "number") continue
      const start = toolUseStarts.find((s) => s.index === parsed.index)
      if (!start?.id) continue
      const arr = deltasById.get(start.id) ?? []
      if (typeof parsed.delta.partial_json === "string") arr.push(parsed.delta.partial_json)
      deltasById.set(start.id, arr)
    }
    expect(JSON.parse((deltasById.get("call_1") ?? []).join(""))).toEqual({ city: "Paris" })
    expect(JSON.parse((deltasById.get("call_2") ?? []).join(""))).toEqual({ city: "Tokyo" })

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
  })
})

describe("openai-oauth: /v1/messages reasoning shapes (per primary case)", () => {
  // Helper that drives a primary case (forced / any / follow-up / parallel) in a given reasoning
  // shape and returns the upstream body so each subtest can assert what the router sent.
  async function drive(
    shape: "absent" | "adaptive",
    body: Record<string, unknown>,
    responses: Array<() => Response>,
  ) {
    const h = harness({ accounts: [codexAccount()], responses })
    const reqBody =
      shape === "adaptive"
        ? {
            ...body,
            thinking: { type: "adaptive" },
            output_config: { effort: "low" },
          }
        : body
    const res = await h.app.request("/v1/messages", post(JSON.stringify(reqBody), bearer()))
    await settle()
    // Every shape must still serve the case: the client body is checked here, and the usage row
    // keeps its outcome and cost basis under both reasoning shapes.
    const client = (await res.clone().json()) as {
      stop_reason: string
      content: ReadonlyArray<{ type: string; id?: string; input?: unknown }>
    }
    const isFollowUp = body === FOLLOWUP_BODY
    expect(client.stop_reason).toBe(isFollowUp ? "end_turn" : "tool_use")
    if (!isFollowUp) {
      const first = client.content.find((block) => block.type === "tool_use")
      expect(first?.id).toBe("call_1")
    }
    expect(h.usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "notional" })
    return { res, ...h, sent: sentBody(h.upstream) }
  }

  const FORCED_BODY = {
    ...MESSAGES_BODY,
    tool_choice: { type: "tool", name: "get_weather" },
  }
  const ANY_BODY = { ...MESSAGES_BODY, tool_choice: { type: "any" } }
  const FOLLOWUP_BODY = {
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
        content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"temperature_c":18}' }],
      },
    ],
  }
  const PARALLEL_BODY = {
    ...MESSAGES_BODY,
    messages: [{ role: "user", content: "Weather in Paris and Tokyo?" }],
    tool_choice: { type: "any" },
  }

  test("forced / absent reasoning — upstream body has no `reasoning` key", async () => {
    const { res, sent, usage } = await drive("absent", FORCED_BODY, [
      () =>
        responsesCallStream({
          itemId: "fc_1",
          callId: "call_1",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        }),
    ])
    expect(res.status).toBe(200)
    expect("reasoning" in sent).toBe(false)
    expect(sent.tool_choice).toEqual({ type: "function", name: "get_weather" })
    expect(usage.rows).toHaveLength(1)
  })

  test("forced / adaptive reasoning — upstream body carries reasoning {effort: low, summary: auto}", async () => {
    const { res, sent, usage } = await drive("adaptive", FORCED_BODY, [
      () =>
        responsesCallStream({
          itemId: "fc_1",
          callId: "call_1",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        }),
    ])
    expect(res.status).toBe(200)
    expect(sent.reasoning).toEqual({ effort: "low", summary: "auto" })
    expect(usage.rows).toHaveLength(1)
  })

  test("any / absent reasoning — upstream body has no `reasoning` key", async () => {
    const { res, sent, usage } = await drive("absent", ANY_BODY, [
      () =>
        responsesCallStream({
          itemId: "fc_1",
          callId: "call_1",
          name: "get_weather",
          arguments: "{}",
        }),
    ])
    expect(res.status).toBe(200)
    expect("reasoning" in sent).toBe(false)
    expect(sent.tool_choice).toBe("required")
    expect(usage.rows).toHaveLength(1)
  })

  test("any / adaptive reasoning — upstream body carries reasoning {effort: low, summary: auto}", async () => {
    const { res, sent, usage } = await drive("adaptive", ANY_BODY, [
      () =>
        responsesCallStream({
          itemId: "fc_1",
          callId: "call_1",
          name: "get_weather",
          arguments: "{}",
        }),
    ])
    expect(res.status).toBe(200)
    expect(sent.reasoning).toEqual({ effort: "low", summary: "auto" })
    expect(usage.rows).toHaveLength(1)
  })

  test("follow-up / absent reasoning — upstream body has no `reasoning` key", async () => {
    const { res, sent, usage } = await drive("absent", FOLLOWUP_BODY, [
      () => responsesTextStream("It's 18°C in Paris."),
    ])
    expect(res.status).toBe(200)
    expect("reasoning" in sent).toBe(false)
    expect(usage.rows).toHaveLength(1)
  })

  test("follow-up / adaptive reasoning — upstream body carries reasoning {effort: low, summary: auto}", async () => {
    const { res, sent, usage } = await drive("adaptive", FOLLOWUP_BODY, [
      () => responsesTextStream("It's 18°C in Paris."),
    ])
    expect(res.status).toBe(200)
    expect(sent.reasoning).toEqual({ effort: "low", summary: "auto" })
    expect(usage.rows).toHaveLength(1)
  })

  test("parallel / absent reasoning — upstream body has no `reasoning` key", async () => {
    const { res, sent, usage } = await drive("absent", PARALLEL_BODY, [
      () =>
        responsesParallelCallsStream([
          {
            itemId: "fc_1",
            callId: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            itemId: "fc_2",
            callId: "call_2",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        ]),
    ])
    expect(res.status).toBe(200)
    expect("reasoning" in sent).toBe(false)
    expect(sent.tool_choice).toBe("required")
    expect(usage.rows).toHaveLength(1)
  })

  test("parallel / adaptive reasoning — upstream body carries reasoning {effort: low, summary: auto}", async () => {
    const { res, sent, usage } = await drive("adaptive", PARALLEL_BODY, [
      () =>
        responsesParallelCallsStream([
          {
            itemId: "fc_1",
            callId: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            itemId: "fc_2",
            callId: "call_2",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        ]),
    ])
    expect(res.status).toBe(200)
    expect(sent.reasoning).toEqual({ effort: "low", summary: "auto" })
    expect(usage.rows).toHaveLength(1)
  })
})

describe("openai-api / openai-responses: /v1/messages with a forced tool call", () => {
  test("stream — upstream keeps sampling fields (no CODEX_RESPONSES_EGRESS); client sees tool_use + stop_reason tool_use", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openaiApiResponsesAccount()],
      responses: [
        () =>
          responsesCallStream({
            itemId: "fc_1",
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
    expect(text).toContain("event: content_block_start")

    expect(upstream.calls[0]?.url).toBe("https://upstream.test/responses")
    const sent = sentBody(upstream)
    // openai-api keeps the sampling fields — the CODEX_RESPONSES_EGRESS rule is Codex-only.
    expect(sent.temperature).toBe(0.2)
    expect(sent.top_p).toBe(0.9)
    expect(sent.tool_choice).toEqual({ type: "function", name: "get_weather" })

    await settle()
    expect(usage.rows).toHaveLength(1)
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
        () =>
          responsesCallStream({
            itemId: "fc_1",
            callId: "call_1",
            name: "get_weather",
            arguments: "{}",
          }),
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
    expect(text).toMatch(/"type":"tool_use"/)
    expect(text).toContain("event: content_block_start")

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "metered" })
  })
})

describe("/v1/chat/completions with tools into a Responses-speaking account", () => {
  test("openai-api / openai-responses — JSON upstream reply carries tool_calls and finish_reason tool_calls", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openaiApiResponsesAccount()],
      responses: [
        () =>
          responsesJsonFunctionCall({
            itemId: "fc_1",
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
    // The upstream returns a JSON Responses object (openai-api does not force-stream on the
    // Responses surface), and the chat-completions response shape translates it to OpenAI Chat
    // with `tool_calls` and `finish_reason: "tool_calls"`. The translator picks `call_id` over
    // `id` when minting the tool_call id, so the client sees `call_1`, not `fc_1`.
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as {
      choices: ReadonlyArray<{
        finish_reason: string
        message: {
          tool_calls: ReadonlyArray<{
            id: string
            type: string
            function: { name: string; arguments: string }
          }>
        }
      }>
    }
    expect(body.choices[0]?.finish_reason).toBe("tool_calls")
    const toolCalls = body.choices[0]?.message.tool_calls ?? []
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.id).toBe("call_1")
    expect(toolCalls[0]?.type).toBe("function")
    expect(toolCalls[0]?.function.name).toBe("get_weather")
    expect(toolCalls[0]?.function.arguments).toBe('{"city":"Paris"}')

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")
    // The JSON reply above is only realistic because openai-api does not force a stream.
    expect(sent.stream).not.toBe(true)

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "metered" })
  })

  test("openai-api / openai-responses — stream:true variant: SSE upstream carries finish_reason tool_calls", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openaiApiResponsesAccount()],
      responses: [
        () =>
          responsesCallStream({
            itemId: "fc_1",
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
          stream: true,
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
    // Stream case: the openai-api Responses egress does not require a stream, so when the client
    // asked for one the upstream stream is forwarded translated, finishing with `tool_calls`.
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text).toContain('"name":"get_weather"')
    expect(text).toContain('"id":"call_1"')

    const sent = sentBody(upstream)
    expect(sent.tool_choice).toBe("required")
    expect(sent.stream).toBe(true)

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", costBasis: "metered" })
  })
})
