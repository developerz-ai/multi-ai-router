import { describe, expect, test } from "bun:test"
import { account, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * A ChatGPT (Codex) account reached across dialects. The Codex backend refuses a non-streaming
 * request, one with no `instructions`, and `max_output_tokens` / `temperature` / `top_p` — so the
 * driver declares those rules, the translator applies them, and a client that did not ask to
 * stream gets the forced stream folded back into one body. The upstream is a mock; nothing here
 * reaches chatgpt.com.
 */

const ACCOUNT_ID = "acct-codex-123"
const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
).toString("base64url")}.sig`

function codexAccount() {
  return {
    ...account("codex", { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
    authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
}

function frame(type: string, fields: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

const ITEM = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello there", annotations: [] }],
}

/** What the Codex backend streams: deltas, the finished item, and a terminal snapshot without it. */
function codexStream(): Response {
  const body = [
    frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...ITEM, status: "in_progress", content: [] },
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
      delta: "hello there",
    }),
    frame("response.output_text.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text: "hello there",
    }),
    frame("response.content_part.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: ITEM.content[0],
    }),
    frame("response.output_item.done", { output_index: 0, item: ITEM }),
    frame("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    }),
  ].join("")
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function sentBody(upstream: {
  calls: readonly { body: string | null }[]
}): Record<string, unknown> {
  return JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
}

function expectCodexShape(sent: Record<string, unknown>): void {
  expect(sent.stream).toBe(true)
  expect(typeof sent.instructions).toBe("string")
  expect(sent.store).toBe(false)
  expect("max_output_tokens" in sent).toBe(false)
  expect("temperature" in sent).toBe(false)
  expect("top_p" in sent).toBe(false)
  expect(sent.model).toBe("gpt-5.5")
}

const ANTHROPIC = {
  model: "gpt-5.5",
  max_tokens: 256,
  temperature: 0.2,
  system: "be terse",
  messages: [{ role: "user", content: "hi" }],
}

describe("anthropic ingress against a Codex account", () => {
  test("non-stream: forced upstream stream, one Anthropic JSON message back, tokens recorded", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [codexStream],
    })
    const res = await app.request("/v1/messages", post(JSON.stringify(ANTHROPIC), bearer()))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as Record<string, unknown>
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.content).toEqual([{ type: "text", text: "hello there" }])

    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.url).toBe("https://upstream.test/responses")
    const sent = sentBody(upstream)
    expectCodexShape(sent)
    expect(sent.instructions).toBe("be terse")
    expect(upstream.calls[0]?.headers.get("chatgpt-account-id")).toBe(ACCOUNT_ID)
    expect(upstream.calls[0]?.headers.get("originator")).toBe("codex_cli_rs")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "translate",
      tokensIn: 11,
      tokensOut: 7,
    })
  })

  test("stream: the client asked to stream and gets Anthropic SSE, event by event", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [codexStream],
    })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...ANTHROPIC, system: undefined, stream: true }), bearer()),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("hello there")
    expect(text).toContain("event: message_stop")

    const sent = sentBody(upstream)
    expectCodexShape(sent)
    expect(sent.instructions).toBe("")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 11, tokensOut: 7 })
  })

  test("stream: bytes reach the client before the upstream has finished", async () => {
    const slow = slowStream([
      frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }) +
        frame("response.output_item.added", {
          output_index: 0,
          item: { ...ITEM, status: "in_progress", content: [] },
        }) +
        frame("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "early",
        }),
      frame("response.completed", {
        response: { id: "resp_1", status: "completed", output: [ITEM] },
      }),
    ])
    const { app } = harness({ accounts: [codexAccount()], responses: [() => slow.response] })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...ANTHROPIC, stream: true }), bearer()),
    )
    if (res.body === null) throw new Error("missing body")
    const reader = res.body.getReader()
    slow.release(0)
    let seen = ""
    while (!seen.includes("early")) {
      const { value, done } = await reader.read()
      if (done) throw new Error("stream ended before the first delta was forwarded")
      seen += new TextDecoder().decode(value)
    }
    // The terminal event has not been released: the delta was forwarded, not collected.
    slow.release(1)
    slow.finish()
    while (!(await reader.read()).done) {}
  })

  test("a forced stream that never finishes fails honestly and is not retried", async () => {
    const truncated = () =>
      new Response(frame("response.created", { response: { id: "r" } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [truncated, truncated],
    })
    const res = await app.request("/v1/messages", post(JSON.stringify(ANTHROPIC), bearer()))
    await expect(res.text()).rejects.toBeDefined()
    await settle()
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ errorClass: "translation_protocol_error" })
  })
})

describe("chat completions ingress against a Codex account", () => {
  test("non-stream: forced upstream stream, one chat.completion back, tokens recorded", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [codexStream],
    })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model: "gpt-5.5",
          max_completion_tokens: 128,
          temperature: 0.4,
          top_p: 0.9,
          messages: [{ role: "user", content: "hi" }],
        }),
        bearer(),
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as {
      object: string
      choices: { message: { content: string } }[]
    }
    expect(body.object).toBe("chat.completion")
    expect(body.choices[0]?.message.content).toBe("hello there")

    const sent = sentBody(upstream)
    expectCodexShape(sent)
    expect(sent.instructions).toBe("")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 11, tokensOut: 7 })
  })
})
