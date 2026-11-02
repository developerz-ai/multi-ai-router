import { describe, expect, test } from "bun:test"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Anthropic's own structured-output constraint, end to end on `/v1/messages`.
 *
 * `anthropicRequestSchema` is a `z.object`, so it strips every key it does not name — and the
 * constraint was not one of them: `output_config.format` (the field Anthropic's Messages API
 * states on the wire) was dropped with the rest of `output_config`, and `output_format` (the name
 * Anthropic's own SDKs take it under) was dropped outright. The constraint was therefore gone
 * before any translator saw it: on a hop that cannot carry it the upstream answered in prose and
 * the caller's `JSON.parse` failed with nothing naming the cause. A constrained answer is a
 * contract, so it is now refused by name, before any upstream call.
 *
 * The same-dialect path is untouched by that rule: a body relayed to an Anthropic-dialect account
 * is a byte relay that never parses it, so the constraint reaches the upstream intact.
 */

const MODEL = "claude-opus-5"

/** A schema carrying a marker property, so an assertion can prove no value was quoted back. */
const SCHEMA = {
  type: "object",
  properties: { secret_marker: { type: "string" } },
  required: ["secret_marker"],
}

const FORMAT = { type: "json_schema", schema: SCHEMA }

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  })
}

function chatAccount() {
  return account("chat-1", { provider: "openrouter", dialect: "openai-chat", cipher: CRYPTOR })
}

function anthropicAccount() {
  return account("anthropic-1", { provider: "anthropic-api", cipher: CRYPTOR })
}

function sent(upstream: { calls: readonly { body: string }[] }): Record<string, unknown> {
  return JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
}

function chatUpstream() {
  return () =>
    jsonResponse(200, {
      id: "chatcmpl-1",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    })
}

describe("an Anthropic request carrying a structured-output constraint", () => {
  test("is refused 400 on an openai-chat account, before any upstream call", async () => {
    const { app, upstream, usage } = harness({
      accounts: [chatAccount()],
      responses: [chatUpstream()],
    })

    const res = await app.request(
      "/v1/messages",
      post(body({ output_config: { format: FORMAT } }), bearer()),
    )
    const rendered = (await res.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }
    await settle()

    expect(res.status).toBe(400)
    expect(rendered.type).toBe("error")
    expect(rendered.error?.type).toBe("invalid_request_error")
    expect(rendered.error?.message).toContain("output_config.format")
    expect(rendered.error?.message).not.toContain("secret_marker")
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ outcome: "client_error", tokensIn: 0, tokensOut: 0 })
  })

  test("the SDK spelling is refused the same way, under its own name", async () => {
    const { app, upstream, usage } = harness({
      accounts: [chatAccount()],
      responses: [chatUpstream()],
    })

    const res = await app.request("/v1/messages", post(body({ output_format: FORMAT }), bearer()))
    const rendered = (await res.json()) as { error?: { type?: string; message?: string } }
    await settle()

    expect(res.status).toBe(400)
    expect(rendered.error?.type).toBe("invalid_request_error")
    expect(rendered.error?.message).toContain("output_format")
    expect(rendered.error?.message).not.toContain("secret_marker")
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows[0]).toMatchObject({ outcome: "client_error" })
  })

  test("is relayed intact to an anthropic-dialect account: the same-dialect path never parses it", async () => {
    const { app, upstream } = harness({
      accounts: [anthropicAccount()],
      responses: [
        () =>
          jsonResponse(200, {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: MODEL,
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 7, output_tokens: 2 },
          }),
      ],
    })

    const res = await app.request(
      "/v1/messages",
      post(body({ output_config: { format: FORMAT } }), bearer()),
    )
    expect(res.status).toBe(200)
    await res.text()
    await settle()

    expect(upstream.calls).toHaveLength(1)
    const forwarded = sent(upstream)
    expect(forwarded.output_config).toEqual({ format: FORMAT })
    expect(forwarded.model).toBe(MODEL)
  })

  test("is relayed intact under its own name too: the deprecated spelling survives the same relay", async () => {
    const { app, upstream } = harness({
      accounts: [anthropicAccount()],
      responses: [
        () =>
          jsonResponse(200, {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: MODEL,
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 7, output_tokens: 2 },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(body({ output_format: FORMAT }), bearer()))
    expect(res.status).toBe(200)
    await res.text()
    await settle()

    expect(upstream.calls).toHaveLength(1)
    const forwarded = sent(upstream)
    expect(forwarded.output_format).toEqual(FORMAT)
    expect(forwarded.model).toBe(MODEL)
  })

  test("is absent from a request that states none: the same body translates and is served", async () => {
    const { app, upstream, usage } = harness({
      accounts: [chatAccount()],
      responses: [chatUpstream()],
    })

    const res = await app.request("/v1/messages", post(body(), bearer()))
    const rendered = (await res.json()) as { content?: { type: string; text: string }[] }
    await settle()

    expect(res.status).toBe(200)
    expect(rendered.content?.[0]?.text).toBe("hi")
    expect(upstream.calls).toHaveLength(1)
    expect(sent(upstream)).not.toHaveProperty("output_format")
    expect(usage.rows[0]).toMatchObject({ outcome: "success" })
  })
})
