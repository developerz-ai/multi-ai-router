import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Production, 2026-10-16: tesote.ai's chat-completions turns routed to ChatGPT (Codex) accounts read
 * 16–22% of their prompt from cache on later steps of one turn — identical prefix, seconds apart —
 * against 98.5% for the same turns via OpenRouter. The caller sent `prompt_cache_key` (and an
 * `x-session-id` naming the same conversation); the translator dropped the key, and the upstream
 * was never told the `session-id` the Codex backend derives cache affinity from.
 *
 * What the first-party Codex CLI sends, and so what this surface is sent: `prompt_cache_key` in the
 * Responses body (openai/codex `codex-api/src/common.rs`) and the same value as the `session-id`
 * header (`core/src/client.rs`: "ChatGPT derives cache affinity from the Responses session-id
 * header"; `codex-api/src/requests/headers.rs`). The upstream is a mock; nothing reaches chatgpt.com.
 */

function token(chatGptAccountId: string): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: chatGptAccountId } }
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
}

function codexAccount(id: string) {
  return {
    ...account(id, { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
    authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: token(`chatgpt-${id}`) })),
  }
}

const ITEM = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "ok", annotations: [] }],
}

function codexStream(): Response {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-5.5",
      output: [ITEM],
      usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 },
    },
  }
  return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function chat(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content }], ...extra })
}

function sentBody(call: { body: string | null } | undefined): Record<string, unknown> {
  return JSON.parse(call?.body ?? "{}") as Record<string, unknown>
}

describe("chat completions → Codex: the caller's prompt cache key reaches the upstream", () => {
  test("prompt_cache_key is carried in the Responses body and sent as the session-id header", async () => {
    const { app, upstream } = harness({ accounts: [codexAccount("a")], responses: [codexStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(chat("hi", { prompt_cache_key: "turn-0193f2" }), {
        ...bearer(),
        "x-session-id": "turn-0193f2",
      }),
    )
    expect(res.status).toBe(200)
    await res.text()
    expect(upstream.calls).toHaveLength(1)
    expect(sentBody(upstream.calls[0]).prompt_cache_key).toBe("turn-0193f2")
    expect(upstream.calls[0]?.headers.get("session-id")).toBe("turn-0193f2")
  })

  test("without a key: no prompt_cache_key and no session-id — the router never invents one", async () => {
    const { app, upstream } = harness({ accounts: [codexAccount("a")], responses: [codexStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(chat("hi"), { ...bearer(), "x-session-id": "turn-0193f2" }),
    )
    expect(res.status).toBe(200)
    await res.text()
    expect("prompt_cache_key" in sentBody(upstream.calls[0])).toBe(false)
    expect(upstream.calls[0]?.headers.has("session-id")).toBe(false)
  })

  test("a key that is not a legal header value still travels in the body, and no header is sent", async () => {
    const { app, upstream } = harness({ accounts: [codexAccount("a")], responses: [codexStream] })
    const res = await app.request(
      "/v1/chat/completions",
      post(chat("hi", { prompt_cache_key: "line\nbreak" }), bearer()),
    )
    expect(res.status).toBe(200)
    await res.text()
    expect(sentBody(upstream.calls[0]).prompt_cache_key).toBe("line\nbreak")
    expect(upstream.calls[0]?.headers.has("session-id")).toBe(false)
  })
})

describe("/v1/responses → Codex (byte relay): the client's own session-id is no longer stripped", () => {
  test("the Codex CLI's session-id header reaches the backend beside its untouched body", async () => {
    const { app, upstream } = harness({ accounts: [codexAccount("a")], responses: [codexStream] })
    const body = JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      instructions: "",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      prompt_cache_key: "thread-77",
      store: false,
    })
    const res = await app.request(
      "/v1/responses",
      post(body, { ...bearer(), "session-id": "thread-77" }),
    )
    expect(res.status).toBe(200)
    await res.text()
    expect(upstream.calls[0]?.body).toBe(body)
    expect(upstream.calls[0]?.headers.get("session-id")).toBe("thread-77")
  })
})

describe("account stickiness on /v1/chat/completions keys on x-session-id", () => {
  test("one x-session-id stays on one Codex account across steps whose openings differ", async () => {
    const accounts = ["a", "b", "c", "d"].map(codexAccount)
    const { app, upstream } = harness({ accounts, responses: [codexStream] })
    for (const step of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      const res = await app.request(
        "/v1/chat/completions",
        post(chat(`step ${step}`), { ...bearer(), "x-session-id": "conversation-42" }),
      )
      expect(res.status).toBe(200)
      await res.text()
      await settle()
    }
    const served = new Set(upstream.calls.map((call) => call.headers.get("chatgpt-account-id")))
    expect(upstream.calls).toHaveLength(8)
    expect(served.size).toBe(1)
  })

  test("without the header the same steps are keyed by their openings and spread", async () => {
    const accounts = ["a", "b", "c", "d"].map(codexAccount)
    const { app, upstream } = harness({ accounts, responses: [codexStream] })
    for (const step of ["one", "two", "three", "four", "five", "six", "seven", "eight"]) {
      const res = await app.request("/v1/chat/completions", post(chat(`step ${step}`), bearer()))
      expect(res.status).toBe(200)
      await res.text()
      await settle()
    }
    const served = new Set(upstream.calls.map((call) => call.headers.get("chatgpt-account-id")))
    // Deterministic: rendezvous hashing over fixed keys and fixed account ids. The control proves
    // the first test's single account is the header's doing, not a pool that only ever picks one.
    expect(served.size).toBeGreaterThan(1)
  })
})
