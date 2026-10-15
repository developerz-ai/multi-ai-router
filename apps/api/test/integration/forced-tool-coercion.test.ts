import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * MiniMax treats `tool_choice` as a hint (live matrix, 2026-10-15): the forced tool comes back as
 * `end_turn` with a text block holding the JSON. The router moves that text into the tool call the
 * request forced — on `/v1/messages` and on the openai-chat translation — and never invents one.
 */

// developerz.ai's structured-output probe, captured from `@ai-sdk/anthropic` `generateObject`.
const PROBE = {
  model: "MiniMax-M3",
  max_tokens: 32768,
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: 'Return the JSON object {"ok": true} and nothing else.' }],
    },
  ],
  tools: [
    {
      name: "json",
      description: "Respond with a JSON object.",
      input_schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  ],
  tool_choice: { type: "any", disable_parallel_tool_use: true },
}

const text =
  (value: string, stop = "end_turn") =>
  () =>
    jsonResponse(200, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "MiniMax-M3",
      content: [{ type: "text", text: value }],
      stop_reason: stop,
      usage: { input_tokens: 5, output_tokens: 6 },
    })

const sse = (value: string) => () =>
  new Response(
    [
      [
        "message_start",
        { message: { id: "msg_1", model: "MiniMax-M3", usage: { input_tokens: 5 } } },
      ],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: value } }],
      ["content_block_stop", { index: 0 }],
      ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } }],
      ["message_stop", {}],
    ]
      .map(
        ([type, body]) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...(body as object) })}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )

const miniMax = () => [account("mm", { provider: "minimax", apiKey: "sk-mm", cipher: CRYPTOR })]

interface Message {
  content: { type: string; id?: string; name?: string; input?: unknown; text?: string }[]
  stop_reason: string
  usage?: unknown
}

describe("/v1/messages: a forced tool answered in text becomes the tool call", () => {
  test("the captured developerz.ai probe against MiniMax returning text with end_turn", async () => {
    const lines: string[] = []
    const logger = createLogger({ level: "info", write: (line: string) => void lines.push(line) })
    const { app, upstream } = harness({
      accounts: miniMax(),
      responses: [text('{"ok": true}')],
      logger,
    })

    const res = await app.request("/v1/messages", post(JSON.stringify(PROBE), bearer()))
    const body = (await res.json()) as Message
    await settle()

    expect(res.status).toBe(200)
    expect(body.stop_reason).toBe("tool_use")
    expect(body.content).toHaveLength(1)
    expect(body.content[0]).toMatchObject({ type: "tool_use", name: "json", input: { ok: true } })
    expect(body.content[0]?.id).toMatch(/^toolu_[A-Za-z0-9]{24}$/)
    expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 6 })
    expect(JSON.parse(upstream.calls[0]?.body ?? "{}").thinking).toEqual({ type: "disabled" })

    const audit = lines.filter((line) => line.includes("forced_tool_coerced"))
    expect(audit).toHaveLength(1)
    expect(audit[0]).not.toContain("ok")
  })

  test("a fenced object is coerced; the schema is not checked", async () => {
    const { app } = harness({ accounts: miniMax(), responses: [text('```json\n{"nope": 1}\n```')] })
    const res = await app.request("/v1/messages", post(JSON.stringify(PROBE), bearer()))
    const body = (await res.json()) as Message
    expect(body.content[0]).toMatchObject({ type: "tool_use", input: { nope: 1 } })
  })

  test("streaming: buffered and re-emitted as a valid SSE tool call", async () => {
    const { app } = harness({ accounts: miniMax(), responses: [sse('{"ok": true}')] })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...PROBE, stream: true }), bearer()),
    )
    const raw = await res.text()
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(raw).toContain('"type":"tool_use"')
    expect(raw).toContain('"stop_reason":"tool_use"')
    expect(raw).toContain(JSON.stringify(JSON.stringify({ ok: true })).slice(1, -1))
    expect(raw.indexOf("message_start")).toBeLessThan(raw.indexOf("message_stop"))
    expect(raw).not.toContain("text_delta")
  })

  test("a named tool is forced even with several declared", async () => {
    const body = {
      ...PROBE,
      tools: [...PROBE.tools, { name: "other", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "json" },
    }
    const { app } = harness({ accounts: miniMax(), responses: [text('{"ok": true}')] })
    const res = await app.request("/v1/messages", post(JSON.stringify(body), bearer()))
    expect(((await res.json()) as Message).content[0]).toMatchObject({ name: "json" })
  })

  describe("never fabricated", () => {
    const unchanged = async (value: string, request: object = PROBE) => {
      const { app } = harness({ accounts: miniMax(), responses: [text(value)] })
      const res = await app.request("/v1/messages", post(JSON.stringify(request), bearer()))
      return (await res.json()) as Message
    }

    test("prose passes through", async () => {
      const body = await unchanged("I cannot do that")
      expect(body.stop_reason).toBe("end_turn")
      expect(body.content).toEqual([{ type: "text", text: "I cannot do that" }])
    })

    test("a JSON array passes through", async () => {
      expect((await unchanged('[{"ok": true}]')).stop_reason).toBe("end_turn")
    })

    test("any with several tools passes through", async () => {
      const body = await unchanged('{"ok": true}', {
        ...PROBE,
        tools: [...PROBE.tools, { name: "other", input_schema: { type: "object" } }],
      })
      expect(body.stop_reason).toBe("end_turn")
    })

    test("no forced choice passes through", async () => {
      const body = await unchanged('{"ok": true}', { ...PROBE, tool_choice: { type: "auto" } })
      expect(body.content[0]?.type).toBe("text")
    })

    test("a real Anthropic account is never coerced", async () => {
      const { app } = harness({ responses: [text('{"ok": true}')] })
      const res = await app.request("/v1/messages", post(JSON.stringify(PROBE), bearer()))
      expect(((await res.json()) as Message).content[0]?.type).toBe("text")
    })

    test("a streamed prose answer is relayed as received", async () => {
      const { app } = harness({ accounts: miniMax(), responses: [sse("Sure, here you go")] })
      const res = await app.request(
        "/v1/messages",
        post(JSON.stringify({ ...PROBE, stream: true }), bearer()),
      )
      const raw = await res.text()
      expect(raw).toContain("text_delta")
      expect(raw).not.toContain("tool_use")
    })
  })
})

describe("/v1/chat/completions over the anthropic translation", () => {
  const chat = (extra: object) =>
    JSON.stringify({ model: "MiniMax-M3", messages: [{ role: "user", content: "hi" }], ...extra })
  type Chat = {
    choices: {
      message: {
        content: string | null
        tool_calls?: { function: { name: string; arguments: string } }[]
      }
      finish_reason: string
    }[]
  }

  test("tool_choice required with one tool returns the tool call", async () => {
    const { app } = harness({ accounts: miniMax(), responses: [text('{"city": "Paris"}')] })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        chat({
          tools: [
            { type: "function", function: { name: "weather", parameters: { type: "object" } } },
          ],
          tool_choice: "required",
        }),
        bearer(),
      ),
    )
    const body = (await res.json()) as Chat
    expect(body.choices[0]?.finish_reason).toBe("tool_calls")
    expect(body.choices[0]?.message.tool_calls?.[0]?.function).toEqual({
      name: "weather",
      arguments: '{"city":"Paris"}',
    })
  })

  test("response_format json_schema returns the JSON as content, finish stop", async () => {
    const { app } = harness({ accounts: miniMax(), responses: [text('{"answer": true}')] })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        chat({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "r",
              schema: { type: "object", properties: { answer: { type: "boolean" } } },
            },
          },
        }),
        bearer(),
      ),
    )
    const body = (await res.json()) as Chat
    expect(body.choices[0]?.message.content).toBe('{"answer":true}')
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
    expect(body.choices[0]?.finish_reason).toBe("stop")
  })

  test("response_format json_schema, streamed, returns the JSON as content deltas", async () => {
    const { app } = harness({ accounts: miniMax(), responses: [sse('{"answer": true}')] })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        chat({
          stream: true,
          response_format: {
            type: "json_schema",
            json_schema: { name: "r", schema: { type: "object" } },
          },
        }),
        bearer(),
      ),
    )
    const raw = await res.text()
    const content = raw
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "")
      .join("")
    expect(content).toBe('{"answer":true}')
    expect(raw).toContain('"finish_reason":"stop"')
  })

  test("prose in reply to a forced tool stays prose", async () => {
    const { app } = harness({ accounts: miniMax(), responses: [text("no thanks")] })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        chat({
          tools: [
            { type: "function", function: { name: "weather", parameters: { type: "object" } } },
          ],
          tool_choice: "required",
        }),
        bearer(),
      ),
    )
    const body = (await res.json()) as Chat
    expect(body.choices[0]?.message.content).toBe("no thanks")
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
  })
})
