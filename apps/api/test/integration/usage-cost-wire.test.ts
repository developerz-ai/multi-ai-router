import { describe, expect, test } from "bun:test"
import { account, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Issue #335: `usage.cost` is the `UsageRecord`'s own estimate, on every response the router writes,
 * and on nothing it relays. Upstreams are mocked; `gpt-6.1-sol` is $2/$10, and $4/$15 from 272k.
 */

const MODEL = "gpt-6.1-sol"
const CHAT = { model: MODEL, messages: [{ role: "user", content: "hi" }] }
const ANTHROPIC = { ...CHAT, max_tokens: 64 }
const RESPONSES = { model: MODEL, input: "hi" }
const SSE = { headers: { "content-type": "text/event-stream" } }

function chatAccount(billing: "metered" | "subscription" = "metered") {
  return account("chat", {
    provider: "openai-api",
    dialect: "openai-chat",
    cipher: CRYPTOR,
    billing,
  })
}
function responsesAccount() {
  return account("resp", { provider: "openai-api", dialect: "openai-responses", cipher: CRYPTOR })
}

function chatBody(prompt: number, completion: number, model = MODEL): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  })
}

const chatFrame = (fields: object) =>
  `data: ${JSON.stringify({ id: "c", model: MODEL, ...fields })}\n\n`
const CONTENT = chatFrame({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })
const FINISH = chatFrame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
const USAGE = chatFrame({
  choices: [],
  usage: { prompt_tokens: 300_000, completion_tokens: 1_000, total_tokens: 301_000 },
})

function chatStream(): Response {
  return new Response(`${CONTENT}${FINISH}${USAGE}data: [DONE]\n\n`, SSE)
}

function responsesFrame(type: string, fields: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

function responsesStream(): Response {
  const body = [
    responsesFrame("response.created", {
      response: { id: "r", status: "in_progress", output: [] },
    }),
    responsesFrame("response.output_text.delta", { item_id: "m", content_index: 0, delta: "ok" }),
    responsesFrame("response.completed", {
      response: {
        id: "r",
        object: "response",
        status: "completed",
        model: MODEL,
        output: [],
        usage: { input_tokens: 300_000, output_tokens: 1_000, total_tokens: 301_000 },
      },
    }),
  ]
  return new Response(body.join(""), SSE)
}

function dataFrames(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
}

type Usage = Record<string, unknown> | undefined
const usageOf = (holder: unknown): Usage => (holder as { usage?: Usage }).usage

describe("non-streamed: the cost equals the row's estimate", () => {
  test("anthropic ingress: the long-context tier, not the base card", async () => {
    const { app, usage } = harness({
      accounts: [chatAccount()],
      responses: [() => chatBody(300_000, 1_000)],
    })
    const res = await app.request("/v1/messages", post(JSON.stringify(ANTHROPIC), bearer()))
    expect(usageOf(await res.json())).toMatchObject({
      cost: 1.215,
      cost_source: "estimated",
      cost_basis: "metered",
    })
    await settle()
    expect(usage.rows.at(-1)).toMatchObject({ costEstimate: "1.215000", costBasis: "metered" })
  })

  test("below the tier the base card prices it", async () => {
    const { app } = harness({
      accounts: [chatAccount()],
      responses: [() => chatBody(100_000, 1_000)],
    })
    const res = await app.request("/v1/messages", post(JSON.stringify(ANTHROPIC), bearer()))
    expect(usageOf(await res.json())?.cost).toBe(0.21)
  })

  test("openai-responses ingress", async () => {
    const { app } = harness({
      accounts: [chatAccount()],
      responses: [() => chatBody(300_000, 1_000)],
    })
    const res = await app.request("/v1/responses", post(JSON.stringify(RESPONSES), bearer()))
    expect(usageOf(await res.json())?.cost).toBe(1.215)
  })

  test("openai-chat ingress, an upstream made to stream folded into one body", async () => {
    const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
    ).toString("base64url")}.sig`
    const { app } = harness({
      accounts: [
        {
          ...account("codex", {
            provider: "openai-oauth",
            cipher: CRYPTOR,
            billing: "subscription",
          }),
          authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
        },
      ],
      responses: [responsesStream],
    })
    const res = await app.request("/v1/chat/completions", post(JSON.stringify(CHAT), bearer()))
    const stated = usageOf(await res.json())
    expect(stated?.cost_basis).toBe("notional")
    expect(typeof stated?.cost).toBe("number")
  })
})

describe("streamed: the final usage frame carries it", () => {
  test("anthropic ingress: message_delta", async () => {
    const { app, usage } = harness({ accounts: [chatAccount()], responses: [chatStream] })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...ANTHROPIC, stream: true }), bearer()),
    )
    const frames = dataFrames(await res.text())
    const delta = frames.find((frame) => frame.type === "message_delta")
    expect(usageOf(delta)?.cost).toBe(1.215)
    expect(frames.filter((frame) => usageOf(frame)?.cost !== undefined)).toHaveLength(1)
    await settle()
    expect(usage.rows.at(-1)?.costEstimate).toBe("1.215000")
  })

  test("openai-chat ingress: the usage chunk, when the client asked for one", async () => {
    const { app } = harness({ accounts: [responsesAccount()], responses: [responsesStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({ ...CHAT, stream: true, stream_options: { include_usage: true } }),
        bearer(),
      ),
    )
    const frames = dataFrames(await res.text())
    expect(usageOf(frames.at(-1))?.cost).toBe(1.215)
  })

  test("openai-chat ingress with no usage asked for adds no frame of its own", async () => {
    const { app, usage } = harness({ accounts: [responsesAccount()], responses: [responsesStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(JSON.stringify({ ...CHAT, stream: true }), bearer()),
    )
    expect(dataFrames(await res.text()).some((frame) => usageOf(frame) != null)).toBe(false)
    await settle()
    expect(usage.rows.at(-1)?.costEstimate).toBe("1.215000")
  })

  test("openai-responses ingress: response.completed", async () => {
    const { app } = harness({ accounts: [chatAccount()], responses: [chatStream] })
    const res = await app.request(
      "/v1/responses",
      post(JSON.stringify({ ...RESPONSES, stream: true }), bearer()),
    )
    const done = dataFrames(await res.text()).find((frame) => frame.type === "response.completed")
    expect(usageOf(done?.response)?.cost).toBe(1.215)
  })

  test("content reaches the client before any usage exists", async () => {
    const slow = slowStream([CONTENT, `${FINISH}${USAGE}data: [DONE]\n\n`])
    const { app } = harness({ accounts: [chatAccount()], responses: [() => slow.response] })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...ANTHROPIC, stream: true }), bearer()),
    )
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error("missing body")
    slow.release(0)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("message_start")
    slow.release(1)
    slow.finish()
    let rest = ""
    for (let step = await reader.read(); !step.done; step = await reader.read()) {
      rest += new TextDecoder().decode(step.value)
    }
    expect(rest).toContain('"cost":1.215')
  })
})

describe("no honest number, no field", () => {
  test("an unknown rate states no cost, and the row stays NULL", async () => {
    const { app, usage } = harness({
      accounts: [chatAccount()],
      responses: [() => chatBody(10, 5, "no-such-model")],
    })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...ANTHROPIC, model: "no-such-model" }), bearer()),
    )
    const stated = usageOf(await res.json())
    expect(stated).toBeDefined()
    expect(stated).not.toHaveProperty("cost")
    expect(stated).not.toHaveProperty("cost_source")
    await settle()
    expect(usage.rows.at(-1)).toMatchObject({ costEstimate: null, costBasis: "unknown" })
  })

  test("an upstream that reported no usage is not stated as free", async () => {
    const { app } = harness({
      accounts: [chatAccount()],
      responses: [
        () =>
          Response.json({
            id: "chatcmpl-1",
            model: MODEL,
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } },
            ],
          }),
      ],
    })
    const res = await app.request("/v1/messages", post(JSON.stringify(ANTHROPIC), bearer()))
    expect(usageOf(await res.json())).not.toHaveProperty("cost")
  })

  test("a subscription account's figure is notional, never spend", async () => {
    const { app, usage } = harness({
      accounts: [chatAccount("subscription")],
      responses: [() => chatBody(100_000, 1_000)],
    })
    const res = await app.request("/v1/messages", post(JSON.stringify(ANTHROPIC), bearer()))
    expect(usageOf(await res.json())).toMatchObject({ cost: 0.21, cost_basis: "notional" })
    await settle()
    expect(usage.rows.at(-1)?.costBasis).toBe("notional")
  })
})

describe("a same-dialect relay is byte-for-byte: no cost, whatever the row says", () => {
  test("a JSON body comes back untouched", async () => {
    const upstreamBody = '{ "id":"c",  "usage": {"prompt_tokens":300000,"completion_tokens":1000} }'
    const { app, usage } = harness({
      accounts: [chatAccount()],
      responses: [
        () => new Response(upstreamBody, { headers: { "content-type": "application/json" } }),
      ],
    })
    const res = await app.request("/v1/chat/completions", post(JSON.stringify(CHAT), bearer()))
    expect(await res.text()).toBe(upstreamBody)
    await settle()
    expect(usage.rows.at(-1)?.costEstimate).toBe("1.215000")
  })

  test("a stream comes back untouched", async () => {
    const { app } = harness({ accounts: [chatAccount()], responses: [chatStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(JSON.stringify({ ...CHAT, stream: true }), bearer()),
    )
    expect(await res.text()).toBe(`${CONTENT}${FINISH}${USAGE}data: [DONE]\n\n`)
  })

  test("a cost the upstream itself states passes through as its own", async () => {
    const upstreamBody = '{"id":"c","usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.5}}'
    const { app } = harness({
      accounts: [chatAccount()],
      responses: [
        () => new Response(upstreamBody, { headers: { "content-type": "application/json" } }),
      ],
    })
    const res = await app.request("/v1/chat/completions", post(JSON.stringify(CHAT), bearer()))
    expect(await res.text()).toBe(upstreamBody)
  })
})

describe("x-router-usage: cost opts a same-dialect relay in", () => {
  const OPT_IN = { ...bearer(), "x-router-usage": "cost" }

  test("a JSON body states the row's estimate beside the upstream's own fields", async () => {
    const upstreamBody = '{ "id":"c",  "usage": {"prompt_tokens":300000,"completion_tokens":1000} }'
    const { app, upstream } = harness({
      accounts: [chatAccount()],
      responses: [
        () => new Response(upstreamBody, { headers: { "content-type": "application/json" } }),
      ],
    })
    const res = await app.request("/v1/chat/completions", post(JSON.stringify(CHAT), OPT_IN))
    expect(await res.json()).toEqual({
      id: "c",
      usage: {
        prompt_tokens: 300_000,
        completion_tokens: 1_000,
        cost: 1.215,
        cost_source: "estimated",
        cost_basis: "metered",
      },
    })
    // A router header: never forwarded to the provider.
    expect(upstream.calls[0]?.headers.get("x-router-usage")).toBeNull()
  })

  test("a stream states it on the usage frame alone, every other frame as sent", async () => {
    const { app } = harness({ accounts: [chatAccount()], responses: [chatStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(JSON.stringify({ ...CHAT, stream: true }), OPT_IN),
    )
    const text = await res.text()
    expect(text.startsWith(`${CONTENT}${FINISH}`)).toBe(true)
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
    const frames = dataFrames(text)
    expect(frames.filter((frame) => usageOf(frame)?.cost !== undefined)).toHaveLength(1)
    expect(usageOf(frames.at(-1))).toMatchObject({ cost: 1.215, cost_basis: "metered" })
  })

  test("an openai-responses stream: response.completed", async () => {
    const { app } = harness({ accounts: [responsesAccount()], responses: [responsesStream] })
    const res = await app.request(
      "/v1/responses",
      post(JSON.stringify({ ...RESPONSES, stream: true }), OPT_IN),
    )
    const done = dataFrames(await res.text()).find((frame) => frame.type === "response.completed")
    expect(usageOf(done?.response)?.cost).toBe(1.215)
  })

  test("a cost the upstream itself states is kept, not overwritten", async () => {
    const upstreamBody = '{"id":"c","usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.5}}'
    const { app } = harness({
      accounts: [chatAccount()],
      responses: [
        () => new Response(upstreamBody, { headers: { "content-type": "application/json" } }),
      ],
    })
    const res = await app.request("/v1/chat/completions", post(JSON.stringify(CHAT), OPT_IN))
    expect(usageOf(await res.json())).toEqual({ prompt_tokens: 1, completion_tokens: 1, cost: 0.5 })
  })

  test("an unknown option is refused before any upstream is asked", async () => {
    const { app, upstream } = harness({ accounts: [chatAccount()], responses: [chatStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(JSON.stringify(CHAT), { ...bearer(), "x-router-usage": "costs" }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("invalid_request")
    expect(body.error.message).toContain('"costs"')
    expect(upstream.calls).toHaveLength(0)
  })
})
