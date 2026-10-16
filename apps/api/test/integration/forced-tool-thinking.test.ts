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

  // Prod regression, 2026-10-15..16 (v2.37.3): the AI SDK forced a tool *and* stated a thinking
  // budget, and the router answered 538 `400`s. The dial yields to the force — thinking is rewritten
  // to disabled and the vendor is served the forced tool, the model untouched.
  for (const thinkingType of ["enabled", "adaptive"] as const) {
    for (const tool_choice of [
      { type: "tool", name: "json" },
      { type: "any", disable_parallel_tool_use: true },
    ]) {
      test(`thinking ${thinkingType} + ${tool_choice.type}: overridden to disabled, served`, async () => {
        const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
        const body = {
          ...FORCED,
          tool_choice,
          thinking: { type: thinkingType, budget_tokens: 2048 },
        }

        const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
        await res.text()
        await settle()

        expect(res.status).toBe(200)
        const upstreamBody = sent(upstream.calls[0]?.body)
        expect(upstreamBody.thinking).toEqual({ type: "disabled" })
        expect(upstreamBody.tool_choice).toEqual(tool_choice)
        expect(upstreamBody.model).toBe("MiniMax-M3")
      })
    }
  }

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
