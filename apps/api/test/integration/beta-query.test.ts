import { describe, expect, test } from "bun:test"
import { jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, MESSAGE, post, settle } from "./harness"

/**
 * Claude Code posts to `/v1/messages?beta=true` — and to `/v1/messages/count_tokens?beta=true`
 * before a turn. Routing matches the path only: `routes/v1/index.ts` registers the bare paths and
 * Hono matches on the pathname, never the query. Nothing pinned that until this suite, so a
 * regression that matched the full URL would 404 the CLI's every call with nobody noticing.
 *
 * Each path is driven with and without the query, on both account kinds:
 *
 *  - a passthrough (Anthropic API-key) account against a mocked upstream — the query is a client
 *    concern and never reaches the upstream URL, which is built from the dialect's own suffix
 *    (`services/dataplane/egress/endpoint.ts`);
 *  - a subscription account, stubbed at the `SdkInvoker` boundary — no `claude` subprocess, ever.
 */

const MESSAGE_OK = () =>
  jsonResponse(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 11, output_tokens: 22 },
  })

const COUNT = JSON.stringify({
  model: "claude-opus-5",
  messages: [{ role: "user", content: "how many tokens is this" }],
})
const COUNTED = () => jsonResponse(200, { input_tokens: 4531 })

const SDK_OK = () =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

describe("POST /v1/messages?beta=true", () => {
  test("routes, relays and accounts exactly like the bare path on a passthrough account", async () => {
    const { app, upstream, usage } = harness({ responses: [MESSAGE_OK, MESSAGE_OK] })

    const bare = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const beta = await app.request("/v1/messages?beta=true", post(MESSAGE, bearer()))
    await settle()

    expect(bare.status).toBe(200)
    expect(beta.status).toBe(200)
    expect(await beta.json()).toEqual(await bare.json())

    // Same upstream suffix, body untouched — and the client's query is not forwarded upstream.
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.url).toBe("https://upstream.test/v1/messages")
    expect(upstream.calls[1]?.url).toBe(upstream.calls[0]?.url)
    expect(upstream.calls[1]?.body).toBe(MESSAGE)
    expect(upstream.calls[1]?.headers.get("x-api-key")).toBe("sk-one")

    expect(usage.rows.map((row) => row.outcome)).toEqual(["success", "success"])
  })

  test("reaches the Agent-SDK transport on a subscription account, same as the bare path", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: async (invocation) => {
        invocation.onUpstreamStarted?.()
        invoked.push(invocation.accountId)
        return SDK_OK()
      },
    })

    const res = await app.request("/v1/messages?beta=true", post(MESSAGE, bearer()))
    const body = (await res.json()) as { stop_reason: string }
    await settle()

    expect(res.status).toBe(200)
    expect(body.stop_reason).toBe("end_turn")
    // The subscription turn ran through the SDK boundary; nothing was proxied over HTTP.
    expect(invoked).toEqual(["sub"])
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("POST /v1/messages/count_tokens?beta=true", () => {
  test("counts exactly like the bare path on a passthrough account", async () => {
    const { app, upstream } = harness({ responses: [COUNTED, COUNTED] })

    const bare = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const beta = await app.request("/v1/messages/count_tokens?beta=true", post(COUNT, bearer()))
    await settle()

    expect(bare.status).toBe(200)
    expect(beta.status).toBe(200)
    expect(await beta.json()).toEqual({ input_tokens: 4531 })
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.url).toBe("https://upstream.test/v1/messages/count_tokens")
    expect(upstream.calls[1]?.body).toBe(COUNT)
  })

  test("is refused by name on a subscription-only pool, same as the bare path", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [COUNTED],
      invokeSdk: async () => {
        invoked.push("sub")
        return SDK_OK()
      },
    })

    const res = await app.request("/v1/messages/count_tokens?beta=true", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string; type: string } }

    expect(res.status).toBe(503)
    expect(body.error.type).toBe("overloaded_error")
    expect(body.error.message).toContain("Claude Agent SDK")
    // No count was invented: no subprocess, no forged request at the provider.
    expect(invoked).toEqual([])
    expect(upstream.calls).toHaveLength(0)
  })
})
