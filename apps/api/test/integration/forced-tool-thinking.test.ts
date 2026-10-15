import { describe, expect, test } from "bun:test"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * The anthropic passthrough to a vendor that thinks by default (MiniMax), end to end: the shape
 * developerz.ai's structured-output probe sends — `@ai-sdk/anthropic` `generateObject`, captured
 * 2026-10-15: a tool named `json`, `tool_choice {type: "any", disable_parallel_tool_use: true}`,
 * no `thinking`.
 */
const FORCED = {
  model: "MiniMax-M3",
  max_tokens: 32768,
  messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
  tools: [
    { name: "json", description: "Respond with a JSON object.", input_schema: { type: "object" } },
  ],
  tool_choice: { type: "any", disable_parallel_tool_use: true },
}
const ok = () =>
  jsonResponse(200, {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "MiniMax-M3",
    content: [{ type: "tool_use", id: "t", name: "json", input: { ok: true } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  })
const miniMax = () => [account("mm", { provider: "minimax", apiKey: "sk-mm", cipher: CRYPTOR })]
const sent = (body: string | undefined) => JSON.parse(body ?? "{}") as Record<string, unknown>

describe("POST /v1/messages, forced tool, anthropic passthrough to MiniMax", () => {
  test("thinking absent: the upstream is told thinking is disabled", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })

    const res = await app.request("/v1/messages", post(JSON.stringify(FORCED), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(sent(upstream.calls[0]?.body)).toEqual({ ...FORCED, thinking: { type: "disabled" } })
  })

  test("thinking enabled: refused 400 in Anthropic's error shape, no upstream call", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
    const body = { ...FORCED, thinking: { type: "enabled", budget_tokens: 2048 } }

    const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
    const json = (await res.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }
    await settle()

    expect(res.status).toBe(400)
    expect(json.type).toBe("error")
    expect(json.error?.type).toBe("invalid_request_error")
    expect(json.error?.message).toContain("tool_choice forces tool use")
    expect(upstream.calls).toHaveLength(0)
  })

  test("real Anthropic is relayed byte for byte", async () => {
    const { app, upstream } = harness({ responses: [ok] })
    const raw = JSON.stringify(FORCED)

    const res = await app.request("/v1/messages", post(raw, bearer()))
    await res.text()
    await settle()

    expect(upstream.calls[0]?.body).toBe(raw)
  })

  test("an auto choice on MiniMax is relayed byte for byte", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
    const raw = JSON.stringify({ ...FORCED, tool_choice: { type: "auto" } })

    const res = await app.request("/v1/messages", post(raw, bearer()))
    await res.text()
    await settle()

    expect(upstream.calls[0]?.body).toBe(raw)
  })
})
