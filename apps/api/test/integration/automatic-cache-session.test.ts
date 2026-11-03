import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * 2026-11-03, two halves of one gap. An OpenAI-wire client routed to Anthropic's own API got zero
 * prompt caching — no breakpoint reached the upstream — so Anthropic's surface now takes the
 * top-level automatic marker on a written body that states none. And OpenRouter pinned a
 * translated conversation to one provider only once a cache hit was observed (`prompt_cache_key`);
 * its body `session_id` starts stickiness from the first turn. The upstream is a mock.
 */

function anthropicMessage(): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function chatCompletion(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "anthropic/claude-sonnet-4.5",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

async function send(
  target: ReturnType<typeof account>,
  respond: () => Response,
  path: string,
  body: string,
): Promise<Record<string, unknown>> {
  const { app, upstream } = harness({ accounts: [target], responses: [respond] })
  const res = await app.request(path, post(body, bearer()))
  expect(res.status).toBe(200)
  await res.text()
  expect(upstream.calls).toHaveLength(1)
  return JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
}

const CHAT = JSON.stringify({
  model: "claude-x",
  messages: [
    { role: "system", content: "you are a coding agent" },
    { role: "user", content: "fix the bug" },
  ],
})

describe("openai-chat client → an anthropic upstream: automatic caching", () => {
  test("anthropic-api: the written body carries the top-level automatic marker", async () => {
    const body = await send(
      account("a", { provider: "anthropic-api", cipher: CRYPTOR }),
      anthropicMessage,
      "/v1/chat/completions",
      CHAT,
    )
    expect(body.cache_control).toEqual({ type: "ephemeral" })
  })

  test("a compatible vendor's anthropic surface is never sent the top-level field", async () => {
    const body = await send(
      account("a", {
        provider: "anthropic-compatible",
        cipher: CRYPTOR,
        baseUrl: "https://vendor.test",
      }),
      anthropicMessage,
      "/v1/chat/completions",
      CHAT,
    )
    expect("cache_control" in body).toBe(false)
  })
})

describe("anthropic client → openrouter: session_id beside prompt_cache_key", () => {
  const MESSAGES = JSON.stringify({
    model: "anthropic/claude-sonnet-4.5",
    max_tokens: 64,
    messages: [{ role: "user", content: "fix the bug" }],
  })

  test("openrouter: session_id is the conversation's cache key", async () => {
    const body = await send(
      account("a", { provider: "openrouter", cipher: CRYPTOR }),
      chatCompletion,
      "/v1/messages",
      MESSAGES,
    )
    expect(typeof body.session_id).toBe("string")
    expect(body.session_id).toBe(body.prompt_cache_key)
  })

  test("openai-api: never sent the OpenRouter-only field", async () => {
    const body = await send(
      account("a", { provider: "openai-api", cipher: CRYPTOR }),
      chatCompletion,
      "/v1/messages",
      MESSAGES,
    )
    expect(typeof body.prompt_cache_key).toBe("string")
    expect("session_id" in body).toBe(false)
  })
})
