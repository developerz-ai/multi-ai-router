import { expect, test } from "bun:test"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`
const wire = [
  {
    type: "message_start",
    message: {
      id: "msg_haiku",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [],
      usage: { input_tokens: 2 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool_1", name: "echo", input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"marker":"OK"}' },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
]
  .map(frame)
  .join("")

for (const stream of [false, true]) {
  test(`Haiku any remains forced through HTTP ingress (stream=${stream})`, async () => {
    const sent: Record<string, unknown>[] = []
    const invokeSdk = createFastInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      errorMaxBytes: 4096,
      credential: async () => ({
        accessToken: "synthetic",
        expiresAt: Date.now() + 3600000,
        deviceId: "a".repeat(64),
        accountUuid: "11111111-1111-4111-8111-111111111111",
      }),
      resolveModel: (_, model) => model,
      sdk: async () => {
        throw new Error("unexpected SDK fallback")
      },
      fetch: async (request) => {
        const body = JSON.parse(await request.text()) as Record<string, unknown>
        sent.push(body)
        if ((body.tool_choice as { type?: string }).type !== "any") {
          return new Response("forced choice was weakened", { status: 400 })
        }
        return new Response(wire, { headers: { "content-type": "text/event-stream" } })
      },
    })
    const h = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk,
      maxAttempts: 1,
    })
    const response = await h.app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          model: "claude-haiku-5-5",
          max_tokens: 256,
          stream,
          tools: [{ name: "echo", input_schema: { type: "object" } }],
          tool_choice: { type: "any" },
          messages: [{ role: "user", content: "Anything you can do." }],
        }),
        bearer(),
      ),
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    if (stream) {
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      const events = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      expect(events).toContainEqual({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool_1", name: "echo", input: {} },
      })
      expect(events).toContainEqual({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"marker":"OK"}' },
      })
      expect(events).toContainEqual({ type: "message_stop" })
    } else {
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(JSON.parse(text)).toMatchObject({
        type: "message",
        model: "claude-haiku-5-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool_1", name: "echo", input: { marker: "OK" } }],
      })
    }
    expect(sent[0]?.tool_choice).toEqual({ type: "any" })
    await settle()
    expect(h.usage.rows).toHaveLength(1)
    expect(h.usage.rows[0]?.outcome).toBe("success")
  })
}
