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

/**
 * Prod 2026-11-05 from 22:41 UTC: 61 `400`s on developerz.ai's MiniMax-M3.1-Flash-Preview rung. The
 * model runs only with adaptive thinking, and the router stated `disabled` beside every forced tool.
 * The upstream below answers the way MiniMax did (message verbatim from the prod log, in the
 * dialect's error envelope) whenever thinking is stated disabled.
 */
const REQUIRES_ADAPTIVE = (model: string) =>
  jsonResponse(400, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `model "${model}" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)`,
    },
  })

describe("POST /v1/messages, forced tool, MiniMax model that requires adaptive thinking", () => {
  for (const model of ["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"]) {
    test(`${model}: thinking is not stated disabled, the forced tool is kept, served`, async () => {
      let refused = 0
      const { app, upstream } = harness({
        accounts: miniMax(),
        responses: [
          async () => {
            const body = sent(upstream.calls.at(-1)?.body)
            if ((body.thinking as { type?: string } | undefined)?.type === "disabled") {
              refused++
              return REQUIRES_ADAPTIVE("MiniMax-M3.1-Flash")
            }
            return ok()
          },
        ],
      })
      const res = await app.request(
        "/v1/messages",
        post(JSON.stringify({ ...FORCED, model }), bearer()),
      )
      await res.text()
      await settle()

      expect(refused).toBe(0)
      expect(res.status).toBe(200)
      const upstreamBody = sent(upstream.calls[0]?.body)
      expect(upstreamBody.thinking).toBeUndefined()
      expect(upstreamBody.tool_choice).toEqual(FORCED.tool_choice)
      expect(upstreamBody.model).toBe(model)
    })
  }

  // Through 2.51.0 the client's `disabled` was dropped and MiniMax ran at its own default, `max`.
  test("a client's own disabled yields to the model's requirement: adaptive at the lowest effort", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
    const body = { ...FORCED, model: "MiniMax-M3.1-Flash", thinking: { type: "disabled" } }

    const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(sent(upstream.calls[0]?.body).thinking).toEqual({ type: "adaptive" })
    expect(sent(upstream.calls[0]?.body).output_config).toEqual({ effort: "low" })
  })

  test("a client's own effort beside disabled is the effort sent, not the vendor default", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
    const body = {
      ...FORCED,
      model: "MiniMax-M3.1-Flash",
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
    }

    const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(sent(upstream.calls[0]?.body).thinking).toEqual({ type: "adaptive" })
    expect(sent(upstream.calls[0]?.body).output_config).toEqual({ effort: "high" })
  })

  test("an adaptive thinking the client stated is relayed beside the force", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
    const raw = JSON.stringify({
      ...FORCED,
      model: "MiniMax-M3.1-Flash",
      thinking: { type: "adaptive" },
    })

    const res = await app.request("/v1/messages", post(raw, bearer()))
    await res.text()
    await settle()

    expect(upstream.calls[0]?.body).toBe(raw)
  })
})

describe("/v1/chat/completions over the anthropic translation, model that requires thinking", () => {
  const chat = (extra: object) =>
    JSON.stringify({
      model: "MiniMax-M3.1-Flash",
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    })
  for (const [name, extra] of [
    [
      "tool_choice required",
      {
        tools: [{ type: "function", function: { name: "json", parameters: { type: "object" } } }],
        tool_choice: "required",
      },
    ],
    [
      "response_format json_schema",
      {
        response_format: {
          type: "json_schema",
          json_schema: { name: "r", schema: { type: "object" } },
        },
      },
    ],
    ["reasoning_effort none", { reasoning_effort: "none" }],
  ] as const) {
    test(`${name}: the translator's disabled becomes adaptive at the lowest effort, served`, async () => {
      const { app, upstream } = harness({
        accounts: miniMax(),
        responses: [
          async () =>
            (sent(upstream.calls.at(-1)?.body).thinking as { type?: string } | undefined)?.type ===
            "disabled"
              ? REQUIRES_ADAPTIVE("MiniMax-M3.1-Flash")
              : ok(),
        ],
      })
      const res = await app.request("/v1/chat/completions", post(chat(extra), bearer()))
      await res.text()
      await settle()

      expect(res.status).toBe(200)
      expect(sent(upstream.calls[0]?.body).thinking).toEqual({ type: "adaptive" })
      expect(sent(upstream.calls[0]?.body).output_config).toEqual({ effort: "low" })
    })
  }

  test("a forced tool beside reasoning_effort high keeps high, never the vendor's max", async () => {
    const { app, upstream } = harness({ accounts: miniMax(), responses: [ok] })
    const body = chat({
      tools: [{ type: "function", function: { name: "json", parameters: { type: "object" } } }],
      tool_choice: "required",
      reasoning_effort: "high",
    })
    const res = await app.request("/v1/chat/completions", post(body, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(sent(upstream.calls[0]?.body).thinking).toEqual({ type: "adaptive" })
    expect(sent(upstream.calls[0]?.body).output_config).toEqual({ effort: "high" })
  })
})
