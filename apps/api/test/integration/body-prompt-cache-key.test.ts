import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * OpenAI's platform (both surfaces) and OpenRouter key their prompt cache by the body's
 * `prompt_cache_key`, not by a header. Before this, the router filled the key only for a surface
 * that declared a cache-key *header* (the Codex driver), so an Anthropic-wire conversation routed to
 * an `openai-api` or `openrouter` account carried none: concurrent sessions sharing one long system
 * prompt spread across the upstream's cache machines and paid cold prefill. The upstream is a mock.
 */

function chatCompletion(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5.5",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

function responsesResult(): Response {
  return Response.json({
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-5.5",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 },
  })
}

function messages(opening: string): string {
  return JSON.stringify({
    model: "gpt-5.5",
    max_tokens: 64,
    system: "you are a coding agent",
    messages: [{ role: "user", content: opening }],
  })
}

function sentBody(call: { body: string | null } | undefined): Record<string, unknown> {
  return JSON.parse(call?.body ?? "{}") as Record<string, unknown>
}

async function sendMessages(
  target: ReturnType<typeof account>,
  respond: () => Response,
  opening: string,
) {
  const { app, upstream } = harness({ accounts: [target], responses: [respond] })
  const res = await app.request("/v1/messages", post(messages(opening), bearer()))
  expect(res.status).toBe(200)
  await res.text()
  expect(upstream.calls).toHaveLength(1)
  return upstream.calls[0]
}

const CASES = [
  {
    name: "openai-api chat surface",
    target: () => account("a", { provider: "openai-api", cipher: CRYPTOR }),
    respond: chatCompletion,
  },
  {
    name: "openai-api responses surface",
    target: () =>
      account("a", { provider: "openai-api", cipher: CRYPTOR, dialect: "openai-responses" }),
    respond: responsesResult,
  },
  {
    name: "openrouter",
    target: () => account("a", { provider: "openrouter", cipher: CRYPTOR }),
    respond: chatCompletion,
  },
] as const

describe("anthropic messages → a body-keyed OpenAI cache: one conversation, one key", () => {
  for (const { name, target, respond } of CASES) {
    test(`${name}: the translated body carries a session-derived prompt_cache_key`, async () => {
      const first = sentBody(await sendMessages(target(), respond, "fix the bug")).prompt_cache_key
      const again = sentBody(await sendMessages(target(), respond, "fix the bug")).prompt_cache_key
      const other = sentBody(await sendMessages(target(), respond, "write docs")).prompt_cache_key
      expect(typeof first).toBe("string")
      expect(again).toBe(first)
      expect(other).not.toBe(first)
    })

    test(`${name}: no cache-key header is invented — the body is the whole signal`, async () => {
      const call = await sendMessages(target(), respond, "fix the bug")
      expect(call?.headers.has("session-id")).toBe(false)
    })
  }
})

describe("what a body-keyed surface does not change", () => {
  test("a same-dialect chat body is relayed byte for byte, with no key added", async () => {
    const { app, upstream } = harness({
      accounts: [account("a", { provider: "openai-api", cipher: CRYPTOR })],
      responses: [chatCompletion],
    })
    const body = JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] })
    const res = await app.request("/v1/chat/completions", post(body, bearer()))
    expect(res.status).toBe(200)
    await res.text()
    expect(upstream.calls[0]?.body).toBe(body)
  })

  test("a translating OpenAI client's own prompt_cache_key wins over the router's", async () => {
    const { app, upstream } = harness({
      accounts: [account("a", { provider: "openai-api", cipher: CRYPTOR })],
      responses: [chatCompletion],
    })
    const body = JSON.stringify({ model: "gpt-5.5", input: "hi", prompt_cache_key: "conv-7" })
    const res = await app.request("/v1/responses", post(body, bearer()))
    expect(res.status).toBe(200)
    await res.text()
    expect(sentBody(upstream.calls[0]).prompt_cache_key).toBe("conv-7")
  })

  test("an Anthropic upstream is never sent the OpenAI-only field", async () => {
    const { app, upstream } = harness({
      accounts: [account("a", { provider: "anthropic-api", cipher: CRYPTOR })],
      responses: [
        () =>
          Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-x",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      ],
    })
    const body = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] })
    const res = await app.request("/v1/chat/completions", post(body, bearer()))
    expect(res.status).toBe(200)
    await res.text()
    expect("prompt_cache_key" in sentBody(upstream.calls[0])).toBe(false)
  })
})
