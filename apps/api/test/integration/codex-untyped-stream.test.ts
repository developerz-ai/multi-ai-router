import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Prod 2026-10-04: Claude Code → `/v1/messages` → a ChatGPT (Codex) account answered HTTP 200 with
 * ~224 KB of Responses SSE and **no `content-type`**. The relay chose stream-vs-JSON from that
 * header, so the streaming client got the raw Responses frames (zero Anthropic events) and the
 * non-streaming retry got the same raw SSE instead of one collected message. The driver declares
 * the surface answers only as a stream (`requireStream`), and that declaration — not a header the
 * upstream may omit — decides how the body is read. The upstream is a mock; nothing reaches
 * chatgpt.com.
 *
 * The fixture is the event set the Responses API streams for a reasoning model (codex-rs
 * `core/tests/common/responses.rs` shapes, with the `sequence_number` / `output_index` /
 * `item_id` fields the live backend adds).
 */

const ACCOUNT_ID = "acct-codex-untyped"
const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
).toString("base64url")}.sig`

function codexAccount() {
  return {
    ...account("codex", { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
    authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
}

let sequence = 0
function frame(type: string, fields: object): string {
  sequence += 1
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...fields })}\n\n`
}

const REASONING = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "Thinking about it." }],
  encrypted_content: Buffer.from("b".repeat(550)).toString("base64"),
}
const MESSAGE = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello there", annotations: [] }],
}
const RESPONSE = { id: "resp_1", object: "response", model: "gpt-6.1-sol" }

/** `echo` pads `response.completed` the way the live backend does (instructions + tools echoed). */
function codexEvents(echo = ""): string {
  sequence = 0
  const text = { item_id: "msg_1", output_index: 1, content_index: 0 }
  const summary = { item_id: "rs_1", output_index: 0, summary_index: 0 }
  return [
    frame("response.created", { response: { ...RESPONSE, status: "in_progress", output: [] } }),
    frame("response.in_progress", { response: { ...RESPONSE, status: "in_progress", output: [] } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...REASONING, summary: [], encrypted_content: null },
    }),
    frame("response.reasoning_summary_part.added", {
      ...summary,
      part: { type: "summary_text", text: "" },
    }),
    frame("response.reasoning_summary_text.delta", { ...summary, delta: "Thinking about it." }),
    frame("response.reasoning_summary_text.done", { ...summary, text: "Thinking about it." }),
    frame("response.reasoning_summary_part.done", { ...summary, part: REASONING.summary[0] }),
    frame("response.output_item.done", { output_index: 0, item: REASONING }),
    frame("response.output_item.added", {
      output_index: 1,
      item: { ...MESSAGE, status: "in_progress", content: [] },
    }),
    frame("response.content_part.added", {
      ...text,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    frame("response.output_text.delta", { ...text, delta: "hello " }),
    frame("response.output_text.delta", { ...text, delta: "there" }),
    frame("response.output_text.done", { ...text, text: "hello there" }),
    frame("response.content_part.done", { ...text, part: MESSAGE.content[0] }),
    frame("response.output_item.done", { output_index: 1, item: MESSAGE }),
    frame("response.completed", {
      response: {
        ...RESPONSE,
        status: "completed",
        ...(echo === "" ? {} : { instructions: echo, tools: [{ type: "function", name: "Bash" }] }),
        output: [REASONING, MESSAGE],
        usage: {
          input_tokens: 21,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 4 },
          total_tokens: 30,
        },
      },
    }),
  ].join("")
}

/** HTTP 200, an event stream, and no `content-type` at all — what prod saw. */
function untypedStream(echo = ""): Response {
  const response = new Response(new TextEncoder().encode(codexEvents(echo)), { status: 200 })
  response.headers.delete("content-type")
  return response
}

const REQUEST = {
  model: "gpt-5.5",
  max_tokens: 256,
  messages: [{ role: "user", content: "hi" }],
}

describe("Codex answers SSE without a content-type", () => {
  test("streaming Anthropic client gets Anthropic SSE, not raw Responses frames", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [() => untypedStream()],
    })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...REQUEST, stream: true }), {
        ...bearer(),
        accept: "application/json",
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: content_block_delta")
    expect(text).toContain('"text_delta","text":"hello "')
    expect(text).toContain("thinking_delta")
    expect(text).toContain("event: message_stop")
    expect(text).not.toContain("response.output_text.delta")

    // The surface answers only as a stream: ask for one, whatever the client's own Accept said.
    expect(upstream.calls[0]?.headers.get("accept")).toBe("text/event-stream")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 21, tokensOut: 9 })
  })

  test("non-streaming Anthropic client gets one collected Anthropic JSON message", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [() => untypedStream()],
    })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify(REQUEST), { ...bearer(), accept: "application/json" }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as { type: string; content: { type: string; text?: string }[] }
    expect(body.type).toBe("message")
    expect(body.content.find((block) => block.type === "text")?.text).toBe("hello there")

    expect(upstream.calls[0]?.headers.get("accept")).toBe("text/event-stream")

    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 21, tokensOut: 9 })
  })

  /**
   * Prod v2.19.1: the same route recorded success with 0/0 tokens because the 224 KB stream's
   * `response.completed` exceeded the 64 KB observation cap and its `usage` was never read.
   */
  test("usage inside an over-cap response.completed is still recorded", async () => {
    const echo = "i".repeat(200_000)
    for (const stream of [true, false]) {
      const { app, usage } = harness({
        accounts: [codexAccount()],
        responses: [() => untypedStream(echo)],
      })
      const res = await app.request(
        "/v1/messages",
        post(JSON.stringify({ ...REQUEST, stream }), { ...bearer(), accept: "application/json" }),
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("hello")
      await settle()
      expect(usage.rows).toHaveLength(1)
      expect(usage.rows[0]).toMatchObject({ outcome: "success", tokensIn: 21, tokensOut: 9 })
    }
  })
})
