import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * Measured 2026-11-06: the Go endpoint answers `400 MissingSessionID` to every request that does not
 * send `x-opencode-session`, on every surface, and the egress allowlist drops client headers by
 * design. So the router has to name the conversation itself. The upstream here is a mock.
 */

const HEADER = "x-opencode-session"

function goAccount(id: string, dialect: "openai-chat" | "anthropic" = "openai-chat") {
  return {
    ...account(id, { provider: "opencode-go", cipher: CRYPTOR, billing: "subscription" }),
    dialect,
  }
}

function chatReply(): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "glm-5.3",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function messagesReply(): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "glm-5.3",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function chat(content: string): string {
  return JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content }] })
}

function messages(content: string): string {
  return JSON.stringify({
    model: "glm-5.3",
    max_tokens: 16,
    messages: [{ role: "user", content }],
  })
}

describe("opencode-go: the router names the conversation", () => {
  test("a chat relay carries the header and our user agent, and the body is untouched", async () => {
    const { app, upstream } = harness({ accounts: [goAccount("a")], responses: [chatReply] })
    const body = chat("hi")

    const res = await app.request("/v1/chat/completions", post(body, bearer()))

    expect(res.status).toBe(200)
    await res.text()
    expect(upstream.calls[0]?.headers.get(HEADER)).toMatch(/^[0-9a-f-]{36}$/)
    expect(upstream.calls[0]?.headers.get("user-agent")).toBe("developerz.ai")
    expect(upstream.calls[0]?.body).toBe(body)
  })

  test("an anthropic relay carries it too", async () => {
    const { app, upstream } = harness({
      accounts: [goAccount("a", "anthropic")],
      responses: [messagesReply],
    })

    const res = await app.request("/v1/messages", post(messages("hi"), bearer()))

    expect(res.status).toBe(200)
    await res.text()
    expect(upstream.calls[0]?.headers.get(HEADER)).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("a translated request carries it too", async () => {
    const { app, upstream } = harness({ accounts: [goAccount("a")], responses: [chatReply] })

    const res = await app.request("/v1/messages", post(messages("hi"), bearer()))

    expect(res.status).toBe(200)
    await res.text()
    expect(upstream.calls[0]?.headers.get(HEADER)).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("two turns of one conversation share an id; another conversation does not", async () => {
    const { app, upstream } = harness({
      accounts: [goAccount("a")],
      responses: [chatReply, chatReply, chatReply],
    })
    const turn = async (session: string) => {
      const res = await app.request(
        "/v1/chat/completions",
        post(chat("hi"), { ...bearer(), "x-session-id": session }),
      )
      await res.text()
    }

    await turn("one")
    await turn("one")
    await turn("two")

    const [first, second, other] = upstream.calls.map((call) => call.headers.get(HEADER))
    expect(second).toBe(first as string)
    expect(other).not.toBe(first as string)
    expect(first).not.toContain("one")
  })

  // developerz.ai, 2026-11-07: an ~866K-token review prompt repeated 40-80 s later read no cache
  // through the router. The id is a pure function of the router key and the session key, so size
  // and concurrency cannot scatter one conversation across Go's backends; a different client
  // `x-session-id` (a new review session) is a different conversation by design.
  test("a multi-megabyte prompt sent twice at once goes up under one id", async () => {
    const { app, upstream } = harness({
      accounts: [goAccount("a")],
      responses: [chatReply],
      maxBodyBytes: 32 * 1024 * 1024,
    })
    const big = chat("x".repeat(3 * 1024 * 1024))

    const [one, two] = await Promise.all([
      app.request("/v1/chat/completions", post(big, bearer())),
      app.request("/v1/chat/completions", post(big, bearer())),
    ])
    await one.text()
    await two.text()

    const ids = upstream.calls.map((call) => call.headers.get(HEADER))
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids[1]).toBe(ids[0])
  })

  test("the client's x-session-id names the conversation: same id kept, a new one is new", async () => {
    const { app, upstream } = harness({ accounts: [goAccount("a")], responses: [chatReply] })
    for (const session of ["review-1", "review-1", "review-2"]) {
      const res = await app.request(
        "/v1/chat/completions",
        post(chat("same prompt"), { ...bearer(), "x-session-id": session }),
      )
      await res.text()
    }
    const ids = upstream.calls.map((call) => call.headers.get(HEADER))
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
  })
})
